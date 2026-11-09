import {
  CommandId,
  EXOWATT_THREADS_FORWARDABLE_TOOLS,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  type ThreadsPendingRequest,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PeerEnvironments from "../../../exowattPeerEnvironments/PeerEnvironments.ts";
import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
} from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { makeEnvironmentSessionScope } from "../../McpToolVisibility.ts";
import {
  deriveThreadTitle,
  threadsDiffRange,
  threadsHandlers,
  threadsListenSummary,
  threadsMilestone,
  threadsNormalizeAnswers,
  threadsPendingRequests,
  threadsTaskCompletions,
  threadsThreadState,
  threadsThreadStatus,
  threadsTranscriptPage,
} from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const NOW = DateTime.makeUnsafe("2026-09-15T12:00:00.000Z");
const LATER = DateTime.makeUnsafe("2026-09-15T12:05:00.000Z");
const PROJECT_ID = ProjectId.make("project-1");
const RELAY = ThreadId.make("thread-relay");
const WORKER = ThreadId.make("thread-worker");
const RUN = RunId.make("run-1");
const CODEX = ProviderInstanceId.make("codex");
const MODEL = { instanceId: CODEX, model: "gpt-5.4" };
const environmentId = EnvironmentId.make("environment-threads-test");
const PEER = EnvironmentId.make("environment-peer");

interface PeerCall {
  readonly environmentId: EnvironmentId;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

const makeShell = (
  id: ThreadId,
  patch: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id,
  projectId: PROJECT_ID,
  title: `Thread ${id}`,
  providerInstanceId: CODEX,
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  branch: null,
  worktreePath: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RUN,
  latestRunRequestedAt: NOW,
  latestRunCompletedAt: NOW,
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: NOW,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 1,
  visibleItemCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  pinnedAt: null,
  deletedAt: null,
  ...patch,
});

const providerScope = (capabilities: ReadonlyArray<"command-center"> = ["command-center"]) =>
  ({
    environmentId,
    requestNamespace: "provider-session-relay",
    thread: {
      threadId: RELAY,
      providerSessionId: "provider-session-relay",
      providerInstanceId: CODEX,
    },
    client: undefined,
    capabilities: new Set(capabilities),
    issuedAt: 0,
  }) satisfies McpInvocationScope;

const environmentScope = () =>
  makeEnvironmentSessionScope({
    environmentId,
    sessionId: "session-agent" as never,
    subject: "claude-code",
    issuedAt: 0,
  });

const message = (
  id: string,
  role: OrchestrationV2ConversationMessage["role"],
  text: string,
  at: number,
): OrchestrationV2ConversationMessage =>
  ({
    id: MessageId.make(id),
    threadId: WORKER,
    runId: RUN,
    role,
    text,
    streaming: false,
    createdBy: role === "user" ? "user" : "agent",
    createdAt: DateTime.makeUnsafe(Date.parse("2026-09-15T12:00:00.000Z") + at * 1_000),
  }) as unknown as OrchestrationV2ConversationMessage;

const approvalPending = (id: string) =>
  ({ id: RuntimeRequestId.make(id), kind: "command", createdAt: NOW }) as const;
const questionPending = (id: string) =>
  ({ id: RuntimeRequestId.make(id), kind: "user_input", createdAt: NOW }) as const;

const pendingProjection = (
  requests: ReadonlyArray<{ id: string; kind: string; status?: string }>,
  items: ReadonlyArray<Record<string, unknown>>,
) =>
  ({
    runtimeRequests: requests.map((request) => ({ status: "pending", ...request })),
    turnItems: items,
  }) as unknown as Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">;

// Harness: one mocked ThreadManagementService around a mutable shell map.

interface HarnessOptions {
  readonly shells?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection?: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  readonly projectDefaultModel?: typeof MODEL | null;
  /** When set, every orchestrator write (dispatch, send, interrupt, launch) fails with it. */
  readonly writeFailure?: unknown;
  /** What the linked peer `PEER` answers to a forwarded call, in wire form. */
  readonly peerAnswer?: (tool: string) => unknown;
}

const makeHarness = Effect.fn("makeThreadsHarness")(function* (options: HarnessOptions = {}) {
  const shells = yield* Ref.make(
    new Map(
      (options.shells ?? [makeShell(RELAY), makeShell(WORKER)]).map((shell) => [shell.id, shell]),
    ),
  );
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const sends = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
  const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
  const recordReads = yield* Ref.make(0);
  const peerCalls = yield* Ref.make<ReadonlyArray<PeerCall>>([]);
  const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();

  const records = {
    messages: options.messages ?? [],
    subagents: options.subagents ?? [],
    providerSessions: [],
    checkpoints: [],
    ...(options.projection ?? { runtimeRequests: [], turnItems: [] }),
  };

  const failWrite = <A>(effect: Effect.Effect<A>): Effect.Effect<A, never> =>
    options.writeFailure === undefined
      ? effect
      : (Effect.fail(options.writeFailure) as unknown as Effect.Effect<A, never>);

  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Ref.get(shells).pipe(Effect.map((map) => map.get(threadId) ?? null)),
      getShellSnapshot: () =>
        Ref.get(shells).pipe(
          Effect.map((map) => ({ threads: [...map.values()], archivedThreads: [] }) as never),
        ),
      listProjectThreads: ({ projectId }) =>
        Ref.get(shells).pipe(
          Effect.map((map) => [...map.values()].filter((shell) => shell.projectId === projectId)),
        ),
      getProjectThreadRecords: ((_target: unknown, fields: ReadonlyArray<string>) =>
        Ref.update(recordReads, (count) => count + 1).pipe(
          Effect.as(
            Object.fromEntries(
              fields.map((field) => [field, records[field as keyof typeof records]]),
            ) as never,
          ),
        )) as never,
      dispatch: (command) =>
        failWrite(
          Ref.update(commands, (recorded) => [...recorded, command]).pipe(
            Effect.as({ sequence: 7, storedEvents: [] } as never),
          ),
        ),
      sendToThread: (input) =>
        failWrite(
          Ref.update(sends, (recorded) => [...recorded, input as never]).pipe(
            Effect.as({
              message: { id: input.messageId },
              run: { id: RUN },
              delivery: "queued",
              dispatch: { sequence: 9 },
            } as never),
          ),
        ),
      interruptThread: () => failWrite(Effect.succeed({ type: "no_active_run" } as never)),
      streamDomainEvents: Stream.fromPubSub(events),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        failWrite(
          Ref.update(launches, (recorded) => [...recorded, input]).pipe(
            Effect.as({
              threadId: input.threadId ?? WORKER,
              projection: {
                thread: { title: input.title },
                runs: [{ id: RUN, userMessageId: input.initialMessage?.messageId }],
              },
            } as never),
          ),
        ),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getShell: (projectId) =>
        Effect.succeed(
          projectId === PROJECT_ID
            ? Option.some({
                id: PROJECT_ID,
                workspaceRoot: "/repo",
                defaultModelSelection:
                  options.projectDefaultModel === undefined ? MODEL : options.projectDefaultModel,
              } as never)
            : Option.none(),
        ),
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({
        environmentId,
        label: "Mac",
        serverVersion: "1.0.0",
      } as never),
    }),
    Layer.mock(PeerEnvironments.PeerEnvironments)({
      list: Effect.succeed({
        enabled: true,
        links: [
          {
            environmentId: PEER,
            label: "devbox",
            httpBaseUrl: "http://127.0.0.1:4000",
            linkedAt: "2026-09-15T12:00:00.000Z",
            expiresAt: "2026-10-15T12:00:00.000Z",
            lastError: "environment devbox is unreachable (connection failed)",
          },
        ],
      }),
      callTool: (target, tool, args, callOptions) =>
        Effect.gen(function* () {
          yield* Ref.update(peerCalls, (calls) => [
            ...calls,
            { environmentId: target, tool, args, timeoutMs: callOptions.timeoutMs },
          ]);
          if (target !== PEER) {
            return yield* new PeerEnvironments.PeerEnvironmentNotLinkedError({
              environmentId: target,
              linkedIds: [PEER],
            });
          }
          return {
            value: options.peerAnswer?.(tool) ?? null,
            label: "devbox",
            serverVersion: "0.9.0",
          };
        }),
    }),
  );
  return { layer, shells, commands, sends, launches, recordReads, events, peerCalls };
});

// Pure projections.

describe("threadsThreadState", () => {
  it("classifies a thread from a coordinator's point of view", () => {
    assert.strictEqual(threadsThreadState(makeShell(WORKER)), "finished");
    assert.strictEqual(
      threadsThreadState(makeShell(WORKER, { latestRunId: null, status: "idle" })),
      "idle",
    );
    assert.strictEqual(threadsThreadState(makeShell(WORKER, { status: "running" })), "running");
    assert.strictEqual(
      threadsThreadState(makeShell(WORKER, { status: "idle", activityRunStatus: "preparing" })),
      "running",
    );
    assert.strictEqual(threadsThreadState(makeShell(WORKER, { status: "failed" })), "failed");
    assert.strictEqual(threadsThreadState(makeShell(WORKER, { archivedAt: NOW })), "archived");
  });

  it("ranks needing the user above a running run", () => {
    const shell = makeShell(WORKER, {
      status: "waiting",
      pendingRuntimeRequest: approvalPending("request-1"),
    });
    assert.strictEqual(threadsThreadState(shell), "needs-you");
    assert.strictEqual(
      threadsThreadState(makeShell(WORKER, { hasActionableProposedPlan: true })),
      "needs-you",
    );
  });

  it("reports settled from the explicit override only, as the sidebar does", () => {
    const settled = threadsThreadStatus(
      makeShell(WORKER, { settledOverride: "settled", settledAt: NOW }),
    );
    assert.strictEqual(settled.settled, true);
    assert.strictEqual(settled.settledAt, "2026-09-15T12:00:00.000Z");
    const active = threadsThreadStatus(
      makeShell(WORKER, { settledOverride: "active", settledAt: NOW }),
    );
    assert.strictEqual(active.settled, false);
    assert.strictEqual(active.settledAt, null);
  });
});

describe("deriveThreadTitle", () => {
  it("uses the first non-empty line, trimmed to a sidebar-sized title", () => {
    assert.strictEqual(deriveThreadTitle("\n  Fix the login bug  \nmore"), "Fix the login bug");
    assert.strictEqual(deriveThreadTitle("   "), "New thread");
    const long = deriveThreadTitle("x".repeat(200));
    assert.strictEqual(long.length, 80);
    assert.ok(long.endsWith("…"));
  });
});

describe("threadsPendingRequests", () => {
  it("joins pending requests to the items that carry their prompt", () => {
    const requests = threadsPendingRequests(
      pendingProjection(
        [
          { id: "approval-1", kind: "command" },
          { id: "question-1", kind: "user_input" },
          { id: "resolved-1", kind: "command", status: "resolved" },
          { id: "auth-1", kind: "auth_refresh" },
        ],
        [
          {
            type: "approval_request",
            requestId: "approval-1",
            title: "Run command",
            prompt: "rm -rf build",
            options: [{ label: "Allow" }, { label: "Deny" }],
          },
          {
            type: "user_input_request",
            requestId: "question-1",
            questions: [
              {
                id: "Which database?",
                question: "Which database?",
                options: [{ label: "sqlite" }],
              },
            ],
          },
        ],
      ),
    );
    assert.deepStrictEqual(requests, [
      {
        requestId: RuntimeRequestId.make("approval-1"),
        kind: "approval",
        prompt: "rm -rf build",
        options: ["Allow", "Deny"],
        questionIds: [],
      },
      {
        requestId: RuntimeRequestId.make("question-1"),
        kind: "question",
        prompt: "Which database?",
        options: ["sqlite"],
        questionIds: ["Which database?"],
      },
    ]);
  });
});

describe("threadsNormalizeAnswers", () => {
  const request = (questionIds: ReadonlyArray<string>): ThreadsPendingRequest => ({
    requestId: RuntimeRequestId.make("question-1"),
    kind: "question",
    prompt: "?",
    options: [],
    questionIds,
  });

  it("keeps matching ids, matches names case-insensitively, and leaves the rest alone", () => {
    assert.deepStrictEqual(
      threadsNormalizeAnswers({ db: "sqlite", ORM: "drizzle", other: "x" }, request(["db", "orm"])),
      { db: "sqlite", orm: "drizzle", other: "x" },
    );
  });

  it("lands any key on the only question", () => {
    assert.deepStrictEqual(threadsNormalizeAnswers({ answer: "yes" }, request(["Proceed?"])), {
      "Proceed?": "yes",
    });
  });
});

describe("threadsListenSummary", () => {
  it("says the milestone, the thread, and only what the user must act on", () => {
    const status = threadsThreadStatus(
      makeShell(WORKER, { title: "Worker", pendingRuntimeRequest: approvalPending("r") }),
      [
        {
          requestId: RuntimeRequestId.make("r"),
          kind: "approval",
          prompt: "Run tests",
          options: ["Allow", "Deny"],
          questionIds: [],
        },
      ],
    );
    assert.strictEqual(
      threadsListenSummary("needs-you", status),
      'needs-you: "Worker": waiting for an approval: Run tests (Allow / Deny)',
    );
    assert.strictEqual(threadsMilestone("idle"), null);
    assert.strictEqual(threadsMilestone("archived"), "finished");
  });
});

describe("threadsTranscriptPage", () => {
  const messages = [
    message("m1", "user", "one", 1),
    message("m2", "assistant", "reply one", 2),
    message("m3", "user", "two", 3),
    message("m4", "assistant", "reply two that is long", 4),
    message("m5", "user", "three", 5),
  ];

  it("pages back by turns, oldest first, and bounds message length", () => {
    const first = threadsTranscriptPage(messages, {
      turnLimit: 2,
      beforeCursor: undefined,
      maxChars: 10,
    });
    assert.deepStrictEqual(
      first.messages.map((entry) => entry.messageId),
      ["m3", "m4", "m5"],
    );
    assert.strictEqual(first.messages[1]?.truncated, true);
    assert.strictEqual(first.hasMore, true);
    assert.strictEqual(first.beforeCursor, "m3");

    const second = threadsTranscriptPage(messages, {
      turnLimit: 2,
      beforeCursor: first.beforeCursor ?? undefined,
      maxChars: 100,
    });
    assert.deepStrictEqual(
      second.messages.map((entry) => entry.messageId),
      ["m1", "m2"],
    );
    assert.strictEqual(second.hasMore, false);
    assert.strictEqual(second.beforeCursor, null);
  });
});

describe("threadsTaskCompletions", () => {
  it("reports finished subagents newest first and skips running ones", () => {
    const subagent = (id: string, status: string, completedAt: DateTime.Utc | null) =>
      ({
        id,
        threadId: WORKER,
        runId: RUN,
        childThreadId: null,
        prompt: "do it",
        title: id,
        status,
        result: `${id} result`,
        startedAt: NOW,
        completedAt,
        updatedAt: completedAt ?? NOW,
      }) as unknown as OrchestrationV2Subagent;
    const completions = threadsTaskCompletions(
      [
        subagent("a", "completed", NOW),
        subagent("b", "running", null),
        subagent("c", "interrupted", LATER),
      ],
      { limit: 10, maxChars: 100 },
    );
    assert.deepStrictEqual(
      completions.map((entry) => [entry.taskId, entry.status]),
      [
        ["c", "stopped"],
        ["a", "completed"],
      ],
    );
  });
});

describe("threadsDiffRange", () => {
  it("resolves the three input forms and names an ambiguous one", () => {
    assert.deepStrictEqual(threadsDiffRange({ threadId: WORKER, turnCount: 3 }), {
      fromTurnCount: 2,
      toTurnCount: 3,
      full: false,
    });
    assert.deepStrictEqual(threadsDiffRange({ threadId: WORKER, full: true, toTurnCount: 4 }), {
      fromTurnCount: 0,
      toTurnCount: 4,
      full: true,
    });
    assert.ok("error" in threadsDiffRange({ threadId: WORKER, turnCount: 1, toTurnCount: 2 }));
    assert.ok("error" in threadsDiffRange({ threadId: WORKER, fromTurnCount: 3, toTurnCount: 2 }));
  });
});

// Handlers.

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** Run a handler against the harness services and one caller scope. */
const run = <A, E>(
  harness: Harness,
  scope: McpInvocationScope,
  effect: Effect.Effect<
    A,
    E,
    | McpInvocationContext
    | ThreadManagement.ThreadManagementService
    | ThreadLaunch.ThreadLaunchService
    | ThreadSearch.ThreadSearch
    | ProjectService.ProjectService
    | CheckpointDiffQuery.CheckpointDiffQuery
    | ServerEnvironment.ServerEnvironment
    | PeerEnvironments.PeerEnvironments
  >,
) =>
  effect.pipe(
    Effect.provide(Layer.merge(harness.layer, Layer.succeed(McpInvocationContext, scope))),
  );

describe("Threads toolkit handlers", () => {
  it.effect("refuses a credential without the command-center capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* run(
        harness,
        providerScope([]),
        threadsHandlers.thread_status({ threadId: WORKER }),
      ).pipe(Effect.flip);
      assert.strictEqual(error._tag, "CommandCenterToolError");
      assert.include(error.detail, "command-center");
    }),
  );

  it.effect("thread_status reads pending requests only when the shell says one is open", () =>
    Effect.gen(function* () {
      const idle = yield* makeHarness();
      const status = yield* run(
        idle,
        providerScope(),
        threadsHandlers.thread_status({ threadId: WORKER }),
      );
      assert.strictEqual(status.state, "finished");
      assert.deepStrictEqual(status.pendingRequests, []);
      assert.strictEqual(yield* Ref.get(idle.recordReads), 0);

      const waiting = yield* makeHarness({
        shells: [makeShell(WORKER, { pendingRuntimeRequest: questionPending("question-1") })],
        projection: pendingProjection(
          [{ id: "question-1", kind: "user_input" }],
          [
            {
              type: "user_input_request",
              requestId: "question-1",
              questions: [{ id: "q", question: "Continue?", options: [] }],
            },
          ],
        ),
      });
      const asked = yield* run(
        waiting,
        providerScope(),
        threadsHandlers.thread_status({ threadId: WORKER }),
      );
      assert.strictEqual(asked.state, "needs-you");
      assert.strictEqual(asked.hasPendingUserInput, true);
      assert.strictEqual(asked.pendingRequests[0]?.prompt, "Continue?");
    }),
  );

  it.effect("Phi hand-back needs you without a runtime request and cannot be responded to", () =>
    Effect.gen(function* () {
      const shell = makeShell(WORKER, {
        latestWorkspaceState: { endState: "awaiting-human", question: "Ship it to prod?" },
      });
      const harness = yield* makeHarness({ shells: [shell] });
      const status = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_status({ threadId: WORKER }),
      );
      assert.strictEqual(status.state, "needs-you");
      assert.isFalse(status.hasPendingUserInput);
      assert.deepStrictEqual(status.pendingRequests, [
        {
          kind: "handback",
          prompt: "Ship it to prod?",
          options: [],
          questionIds: [],
        },
      ]);
      assert.strictEqual(yield* Ref.get(harness.recordReads), 0);
      const error = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_respond({ threadId: WORKER, answers: { answer: "yes" } }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "thread_forward");
      const explicit = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_respond({
          threadId: WORKER,
          requestId: RuntimeRequestId.make("workspace-state:1"),
          answers: { answer: "yes" },
        }),
      ).pipe(Effect.flip);
      assert.include(explicit.detail, "thread_forward");
      assert.lengthOf(yield* Ref.get(harness.commands), 0);
      assert.strictEqual(
        threadsThreadState(
          makeShell(WORKER, {
            ...shell,
            status: "running",
          }),
        ),
        "running",
      );
      assert.strictEqual(
        threadsThreadState(
          makeShell(WORKER, {
            ...shell,
            latestWorkspaceState: { endState: "complete" },
          }),
        ),
        "finished",
      );
    }),
  );

  it.effect("thread_status fails cleanly for an unknown or deleted thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ shells: [makeShell(WORKER, { deletedAt: NOW })] });
      const error = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_status({ threadId: WORKER }),
      ).pipe(Effect.flip);
      assert.strictEqual(error.detail, "thread not found");
    }),
  );

  it.effect("thread_list drops subagent and settled threads on request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [
          makeShell(RELAY, { updatedAt: LATER }),
          makeShell(WORKER, { settledOverride: "settled", settledAt: NOW }),
          makeShell(ThreadId.make("thread-sub"), {
            lineage: {
              rootThreadId: RELAY,
              parentThreadId: RELAY,
              relationshipToParent: "subagent",
            },
          }),
        ],
      });
      const all = yield* run(harness, providerScope(), threadsHandlers.thread_list({}));
      assert.deepStrictEqual(
        all.threads.map((thread) => thread.threadId),
        [RELAY, WORKER],
      );
      const unsettled = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_list({ includeSettled: false, includeSubagents: true }),
      );
      assert.deepStrictEqual(
        unsettled.threads.map((thread) => thread.threadId).toSorted(),
        [RELAY, ThreadId.make("thread-sub")].toSorted(),
      );
    }),
  );

  it.effect("thread_forward queues an agent message with the caller as sender", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_forward({ threadId: WORKER, text: "please rebase" }),
      );
      assert.strictEqual(result.delivery, "queued");
      assert.strictEqual(result.runId, RUN);
      const [send] = yield* Ref.get(harness.sends);
      assert.include(send, {
        threadId: WORKER,
        projectId: PROJECT_ID,
        text: "please rebase",
        mode: "queue",
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: RELAY,
      });
    }),
  );

  it.effect("thread_forward refuses to talk to itself; an environment session has no sender", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const self = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_forward({ threadId: RELAY, text: "hi" }),
      ).pipe(Effect.flip);
      assert.include(self.detail, "itself");

      yield* run(
        harness,
        environmentScope(),
        threadsHandlers.thread_forward({ threadId: WORKER, text: "from outside" }),
      );
      const [send] = yield* Ref.get(harness.sends);
      assert.strictEqual(send?.senderThreadId, undefined);
    }),
  );

  it.effect("thread_create launches with the project default model and the brief", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_create({ text: "Audit the cache\nin detail" }),
      );
      assert.strictEqual(result.runId, RUN);
      const [launch] = yield* Ref.get(harness.launches);
      assert.strictEqual(launch?.projectId, PROJECT_ID);
      assert.strictEqual(launch?.title, "Audit the cache");
      assert.strictEqual(launch?.generateTitle, true);
      assert.deepStrictEqual(launch?.modelSelection, MODEL);
      assert.deepStrictEqual(launch?.workspaceStrategy, { type: "root" });
      assert.strictEqual(launch?.initialMessage?.senderThreadId, RELAY);
      assert.strictEqual(launch?.createdBy, "agent");
      assert.strictEqual(launch?.creationSource, "mcp");
    }),
  );

  it.effect("thread_create needs a projectId from an environment session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* run(
        harness,
        environmentScope(),
        threadsHandlers.thread_create({ text: "work" }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "projectId is required");

      yield* run(
        harness,
        environmentScope(),
        threadsHandlers.thread_create({
          text: "work",
          projectId: PROJECT_ID,
          title: "Named",
          worktreePath: "/tmp/wt",
        }),
      );
      const [launch] = yield* Ref.get(harness.launches);
      assert.strictEqual(launch?.generateTitle, undefined);
      assert.deepStrictEqual(launch?.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: "/tmp/wt",
      });
      assert.strictEqual(launch?.initialMessage?.senderThreadId, undefined);
    }),
  );

  /** A *reverse* (receiver-gated) linked-environment session, bounded by this server's own inbound ceiling. */
  const peerSessionScope = (peerCeiling?: "approval-required" | "auto-accept-edits") =>
    makeEnvironmentSessionScope({
      environmentId,
      sessionId: "session-peer" as never,
      subject: "p3-peer",
      issuedAt: 0,
      peer: true,
      gated: true,
      ...(peerCeiling === undefined ? {} : { peerCeiling }),
    });

  /**
   * A *forward* linked-environment session: minted by this server on an environment it already
   * trusts (it launched that environment over SSH, or the user paired it). It carries no
   * ceiling at all, exactly as it did before reverse links existed.
   */
  const forwardPeerSessionScope = () =>
    makeEnvironmentSessionScope({
      environmentId,
      sessionId: "session-peer-forward" as never,
      subject: "p3-peer",
      issuedAt: 0,
      peer: true,
    });

  it.effect(
    "thread_create from a forward-linked environment runs unceilinged, byte-for-byte pre-reverse-links behaviour",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shells: [makeShell(WORKER, { worktreePath: "/repo/.worktrees/known" })],
        });
        yield* run(
          harness,
          forwardPeerSessionScope(),
          threadsHandlers.thread_create({
            text: "work",
            projectId: PROJECT_ID,
            runtimeMode: "full-access",
            worktreePath: "/anywhere/at/all",
          }),
        );
        const [launch] = yield* Ref.get(harness.launches);
        // No ceiling lowers the requested mode, and no worktree allowlist applies.
        assert.strictEqual(launch?.runtimeMode, "full-access");
        assert.deepStrictEqual(launch?.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath: "/anywhere/at/all",
        });
        // Normal MessageId, not the gated peer prefix: this server's inbound setting cannot
        // find or cancel this run at all, forward is simply not its business.
        assert.isFalse((launch?.initialMessage?.messageId ?? "").startsWith("message:p3-peer:"));
      }),
  );

  it.effect(
    "thread_forward from a forward-linked environment into a full-access thread works unceilinged",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shells: [makeShell(WORKER, { runtimeMode: "full-access" })],
        });
        yield* run(
          harness,
          forwardPeerSessionScope(),
          threadsHandlers.thread_forward({ threadId: WORKER, text: "go" }),
        );
        assert.lengthOf(yield* Ref.get(harness.sends), 1);
      }),
  );

  it.effect("thread_create from a linked environment runs at this server's inbound ceiling", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const runtimeMode of ["full-access", undefined, "approval-required"] as const) {
        yield* run(
          harness,
          peerSessionScope("auto-accept-edits"),
          threadsHandlers.thread_create({
            text: "work",
            projectId: PROJECT_ID,
            ...(runtimeMode === undefined ? {} : { runtimeMode }),
          }),
        );
      }
      assert.deepStrictEqual(
        (yield* Ref.get(harness.launches)).map((launch) => launch.runtimeMode),
        ["auto-accept-edits", "auto-accept-edits", "approval-required"],
      );
      const refused = yield* run(
        harness,
        peerSessionScope(),
        threadsHandlers.thread_create({ text: "work", projectId: PROJECT_ID }),
      ).pipe(Effect.flip);
      assert.include(refused.detail, "agents from other environments are off here");
      assert.lengthOf(yield* Ref.get(harness.launches), 3);
    }),
  );

  it.effect("thread_create from a linked environment only uses known worktrees", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(WORKER, { worktreePath: "/repo/.worktrees/known" })],
      });
      const refused = yield* run(
        harness,
        peerSessionScope("auto-accept-edits"),
        threadsHandlers.thread_create({
          text: "work",
          projectId: PROJECT_ID,
          worktreePath: "/etc",
        }),
      ).pipe(Effect.flip);
      assert.include(refused.detail, "/etc is neither");
      assert.deepStrictEqual(yield* Ref.get(harness.launches), []);
      for (const worktreePath of ["/repo/.worktrees/x/../known/", "/repo"]) {
        yield* run(
          harness,
          peerSessionScope("auto-accept-edits"),
          threadsHandlers.thread_create({ text: "work", projectId: PROJECT_ID, worktreePath }),
        );
      }
      // The launch gets the path that was checked, not the raw input.
      assert.deepStrictEqual(
        (yield* Ref.get(harness.launches)).map((launch) => launch.workspaceStrategy),
        [
          { type: "existing_worktree", worktreePath: "/repo/.worktrees/known" },
          { type: "existing_worktree", worktreePath: "/repo" },
        ],
      );
      yield* run(
        harness,
        environmentScope(),
        threadsHandlers.thread_create({
          text: "work",
          projectId: PROJECT_ID,
          worktreePath: "/etc",
        }),
      );
      assert.lengthOf(yield* Ref.get(harness.launches), 3);
    }),
  );

  it.effect("thread_forward from a linked environment refuses a thread above the ceiling", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [
          makeShell(RELAY, { runtimeMode: "approval-required" }),
          makeShell(WORKER, { runtimeMode: "full-access" }),
        ],
      });
      const refused = yield* run(
        harness,
        peerSessionScope("auto-accept-edits"),
        threadsHandlers.thread_forward({ threadId: WORKER, text: "rebase" }),
      ).pipe(Effect.flip);
      assert.include(refused.detail, "above the auto-accept-edits");
      assert.include(refused.detail, "Agents from my other environments may act here");
      assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      yield* run(
        harness,
        peerSessionScope("auto-accept-edits"),
        threadsHandlers.thread_forward({ threadId: RELAY, text: "rebase" }),
      );
      assert.lengthOf(yield* Ref.get(harness.sends), 1);
    }),
  );

  it.effect("thread_update maps each field onto its own v2 command", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_update({
          threadId: WORKER,
          title: "Renamed",
          runtimeMode: "approval-required",
          settled: true,
          pinned: false,
          snoozedUntil: null,
        }),
      );
      const commands = yield* Ref.get(harness.commands);
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        [
          "thread.metadata.update",
          "thread.runtime-mode.set",
          "thread.settle",
          "thread.unpin",
          "thread.unsnooze",
        ],
      );
      const error = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_update({ threadId: WORKER }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "pass at least one");
    }),
  );

  it.effect("every write tool returns the orchestrator's reason, not the generic wrapper", () =>
    Effect.gen(function* () {
      const reason =
        "Thread thread-worker has a queued message. Send it or remove it from the queue before settling.";
      const harness = yield* makeHarness({
        writeFailure: new OrchestratorCommandRejectedError({
          commandId: CommandId.make("command-settle"),
          commandType: "thread.settle",
          cause: reason,
        }),
      });
      const failures = [
        threadsHandlers.thread_update({ threadId: WORKER, settled: true }),
        threadsHandlers.thread_update({ threadId: WORKER, title: "Renamed" }),
        threadsHandlers.thread_unpin({ threadId: WORKER }),
        threadsHandlers.thread_unsnooze({ threadId: WORKER }),
        threadsHandlers.thread_interrupt({ threadId: WORKER }),
        threadsHandlers.thread_delete({ threadId: WORKER, confirm: true }),
      ].map((call) => run(harness, providerScope(), call).pipe(Effect.flip));
      const sendFailures = [
        run(
          harness,
          providerScope(),
          threadsHandlers.thread_forward({ threadId: WORKER, text: "hello" }),
        ).pipe(Effect.flip),
        run(
          harness,
          providerScope(),
          threadsHandlers.thread_create({ projectId: PROJECT_ID, text: "brief" }),
        ).pipe(Effect.flip),
      ];
      for (const failure of [...failures, ...sendFailures]) {
        const error = yield* failure;
        assert.strictEqual(error.detail, reason);
        assert.notInclude(error.detail, "Failed to dispatch");
        assert.notInclude(error.detail, "rejected before commit");
      }

      const dispatchFailed = yield* makeHarness({
        writeFailure: new OrchestratorDispatchError({
          commandId: CommandId.make("command-settle"),
          commandType: "thread.settle",
          cause: new Error("Thread thread-worker has an active run."),
        }),
      });
      const error = yield* run(
        dispatchFailed,
        providerScope(),
        threadsHandlers.thread_update({ threadId: WORKER, settled: true }),
      ).pipe(Effect.flip);
      assert.strictEqual(error.detail, "Thread thread-worker has an active run.");
    }),
  );

  it.effect("thread_respond infers the one open request and re-keys answers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(WORKER, { pendingRuntimeRequest: questionPending("question-1") })],
        projection: pendingProjection(
          [{ id: "question-1", kind: "user_input" }],
          [
            {
              type: "user_input_request",
              requestId: "question-1",
              questions: [{ id: "Proceed?", question: "Proceed?", options: [] }],
            },
          ],
        ),
      });
      yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_respond({ threadId: WORKER, answers: { answer: "yes" } }),
      );
      const [command] = yield* Ref.get(harness.commands);
      assert.deepStrictEqual(command, {
        type: "runtime-request.respond",
        commandId: command?.commandId as CommandId,
        threadId: WORKER,
        requestId: RuntimeRequestId.make("question-1"),
        answers: { "Proceed?": "yes" },
      });

      const noApproval = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_respond({ threadId: WORKER, decision: "accept" }),
      ).pipe(Effect.flip);
      assert.include(noApproval.detail, "no pending approval");
    }),
  );

  it.effect("thread_delete needs confirm and dispatches thread.delete", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refused = yield* run(
        harness,
        environmentScope(),
        threadsHandlers.thread_delete({ threadId: WORKER, confirm: false as never }),
      ).pipe(Effect.flip);
      assert.include(refused.detail, "confirm: true");
      yield* run(
        harness,
        environmentScope(),
        threadsHandlers.thread_delete({ threadId: WORKER, confirm: true }),
      );
      assert.deepStrictEqual(
        (yield* Ref.get(harness.commands)).map((command) => command.type),
        ["thread.delete"],
      );
    }),
  );

  it.effect("thread_listen returns at once when the thread is already at a milestone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_listen({ threadId: WORKER, timeoutMs: 1_000 }),
      );
      assert.strictEqual(result.milestone, "finished");
    }),
  );

  it.effect("thread_listen stays attached until an event moves the thread to a milestone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(WORKER, { status: "running", activityRunStatus: "running" })],
      });
      const fiber = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_listen({ threadId: WORKER, timeoutMs: 60_000 }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Ref.update(harness.shells, (map) =>
        new Map(map).set(WORKER, makeShell(WORKER, { status: "failed", lastError: "boom" })),
      );
      yield* PubSub.publish(harness.events, { threadId: WORKER } as OrchestrationV2DomainEvent);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.milestone, "failed");
      assert.strictEqual(result.summary, `failed: "Thread ${WORKER}": boom`);
    }),
  );
});

describe("Threads toolkit forwarding to linked environments", () => {
  const remoteStatus = threadsThreadStatus(makeShell(WORKER, { title: "On the devbox" }));

  it.effect("forwards to a linked peer with environmentId stripped and decodes its answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ peerAnswer: () => remoteStatus });
      const status = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_status({ threadId: WORKER, environmentId: PEER }),
      );
      assert.strictEqual(status.title, "On the devbox");
      const calls = yield* Ref.get(harness.peerCalls);
      assert.deepStrictEqual(
        calls.map(({ environmentId: target, tool, args, timeoutMs }) => ({
          target,
          tool,
          args,
          timeoutMs,
        })),
        [{ target: PEER, tool: "thread_status", args: { threadId: WORKER }, timeoutMs: 60_000 }],
      );
    }),
  );

  it.effect("runs locally without environmentId or with this environment's own id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ peerAnswer: () => remoteStatus });
      const omitted = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_status({ threadId: WORKER }),
      );
      const own = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_status({ threadId: WORKER, environmentId }),
      );
      assert.strictEqual(omitted.title, `Thread ${WORKER}`);
      assert.strictEqual(own.title, `Thread ${WORKER}`);
      assert.deepStrictEqual(yield* Ref.get(harness.peerCalls), []);
    }),
  );

  it.effect("never forwards onward for a linked environment's own session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ peerAnswer: () => remoteStatus });
      const peerSession = makeEnvironmentSessionScope({
        environmentId,
        sessionId: "session-peer" as never,
        subject: "p3-peer",
        issuedAt: 0,
        peer: true,
      });
      const error = yield* run(
        harness,
        peerSession,
        threadsHandlers.thread_status({ threadId: WORKER, environmentId: PEER }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "cannot reach environments linked here");
      assert.deepStrictEqual(yield* Ref.get(harness.peerCalls), []);
      const local = yield* run(
        harness,
        peerSession,
        threadsHandlers.thread_status({ threadId: WORKER }),
      );
      assert.strictEqual(local.title, `Thread ${WORKER}`);
    }),
  );

  it.effect("names the linked environments when the id is not one of them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_list({ environmentId: EnvironmentId.make("environment-gone") }),
      ).pipe(Effect.flip);
      assert.strictEqual(error.tool, "thread_list");
      assert.include(error.detail, "environment-gone is not linked");
      assert.include(error.detail, PEER);
    }),
  );

  it.effect("reports version skew instead of returning a mistyped answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ peerAnswer: () => ({ threads: "not a list" }) });
      const error = yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_list({ environmentId: PEER }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "does not understand");
      assert.include(error.detail, "1.0.0");
      assert.include(error.detail, "0.9.0");
    }),
  );

  it.effect("refuses to forward without the command-center capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ peerAnswer: () => remoteStatus });
      const error = yield* run(
        harness,
        providerScope([]),
        threadsHandlers.thread_status({ threadId: WORKER, environmentId: PEER }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "command-center");
      assert.deepStrictEqual(yield* Ref.get(harness.peerCalls), []);
    }),
  );

  it.effect("caps a forwarded thread_create at the calling thread's runtime mode", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        shells: [makeShell(RELAY, { runtimeMode: "approval-required" }), makeShell(WORKER)],
        peerAnswer: () => ({ threadId: WORKER, title: "Remote", messageId: "m-1", runId: null }),
      });
      yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_create({
          text: "Do the thing",
          projectId: PROJECT_ID,
          runtimeMode: "full-access",
          environmentId: PEER,
        }),
      );
      yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_create({
          text: "And this",
          projectId: PROJECT_ID,
          environmentId: PEER,
        }),
      );
      yield* run(
        harness,
        environmentScope(),
        threadsHandlers.thread_create({
          text: "From outside",
          projectId: PROJECT_ID,
          runtimeMode: "auto",
          environmentId: PEER,
        }),
      );
      const modes = (yield* Ref.get(harness.peerCalls)).map((call) => call.args.runtimeMode);
      assert.deepStrictEqual(modes, ["approval-required", "approval-required", "auto"]);
      assert.deepStrictEqual(yield* Ref.get(harness.launches), []);
    }),
  );

  it.effect("gives a forwarded thread_listen its own wait plus headroom", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        peerAnswer: () => ({
          threadId: WORKER,
          milestone: "finished",
          summary: "finished",
          status: remoteStatus,
          waitedMs: 5,
        }),
      });
      yield* run(
        harness,
        providerScope(),
        threadsHandlers.thread_listen({ threadId: WORKER, timeoutMs: 1_000, environmentId: PEER }),
      );
      assert.deepStrictEqual(
        (yield* Ref.get(harness.peerCalls)).map((call) => call.timeoutMs),
        [31_000],
      );
    }),
  );

  it.effect("environment_list shows this environment and its peers without tokens", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const listed = yield* run(harness, environmentScope(), threadsHandlers.environment_list({}));
      assert.deepStrictEqual(listed.local, { environmentId, label: "Mac" });
      assert.strictEqual(listed.linkingEnabled, true);
      assert.deepStrictEqual(
        listed.peers.map((peer) => [peer.environmentId, peer.label, peer.lastError]),
        [[PEER, "devbox", "environment devbox is unreachable (connection failed)"]],
      );
      assert.notProperty(listed.peers[0], "token");
    }),
  );

  it.effect(
    "environment_list hides this environment's links from a linked environment's session",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const peerSession = makeEnvironmentSessionScope({
          environmentId,
          sessionId: "session-peer" as never,
          subject: "p3-peer",
          issuedAt: 0,
          peer: true,
        });
        const listed = yield* run(harness, peerSession, threadsHandlers.environment_list({}));
        assert.deepStrictEqual(listed.local, { environmentId, label: "Mac" });
        assert.strictEqual(listed.linkingEnabled, true);
        assert.deepStrictEqual(listed.peers, []);
      }),
  );

  it("only the forwardable tools accept environmentId", () => {
    const forwardable = new Set<string>(EXOWATT_THREADS_FORWARDABLE_TOOLS);
    for (const [name, tool] of Object.entries(ThreadsToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool) as { properties?: Record<string, unknown> };
      assert.strictEqual(
        Object.hasOwn(schema.properties ?? {}, "environmentId"),
        forwardable.has(name),
        name,
      );
    }
  });
});
