import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makePiAdapterV2, type PiRpcRecord } from "@t3tools/provider-pi/server";
import * as HarnessLaunchEnvironment from "../../provider/HarnessLaunchEnvironment.ts";
import { makePhiAdapterV2Flavor, PhiAdapterV2Driver, PHI_PROVIDER } from "./PhiAdapterV2.ts";

type ProviderAdapterV2Event = ProviderAdapter.ProviderAdapterV2Event;
type ProviderAdapterV2SessionRuntime = ProviderAdapter.ProviderAdapterV2SessionRuntime;
type ProviderAdapterV2TurnMessage = ProviderAdapter.ProviderAdapterV2TurnMessage;

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PHI_INSTANCE_ID = ProviderInstanceId.make("phi");
const THREAD_ID = ThreadId.make("thread-phi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-phi-test");
const SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_phi.jsonl";

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const selection = (model: string): ModelSelection => ({ instanceId: PHI_INSTANCE_ID, model });

/** A Phi process on stdio: acks every request, answers state queries idle. */
const makeFakePhi = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const allRequests: Array<PiRpcRecord> = [];
  let stdinBuffer = "";
  let spawnEnv: NonNullable<ChildProcess.CommandOptions["env"]> = {};
  let failNextModel = false;
  let failNextThinking = false;

  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );

  const respond = (record: PiRpcRecord): PiRpcRecord | null => {
    // Pi acks an id-less `prompt` too; the adapter waits for it before settling
    // a turn that joined a native run.
    if (record["type"] === "prompt") return { type: "response", command: "prompt", success: true };
    if (typeof record["id"] !== "string") return null;
    const base = { type: "response", id: record["id"], command: record["type"], success: true };
    if (record["type"] === "set_model" && failNextModel) {
      failNextModel = false;
      return { ...base, success: false, error: "model unavailable" };
    }
    if (record["type"] === "set_thinking_level" && failNextThinking) {
      failNextThinking = false;
      return { ...base, success: false, error: "thinking unavailable" };
    }
    switch (record["type"]) {
      case "get_state":
        return {
          ...base,
          data: { thinkingLevel: "high", isStreaming: false, sessionFile: SESSION_FILE },
        };
      case "get_available_models":
        return { ...base, data: { models: [] } };
      case "get_commands":
        return { ...base, data: { commands: [] } };
      case "switch_session":
      case "new_session":
        return { ...base, data: { cancelled: false } };
      default:
        return base;
    }
  };

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) spawnEnv = command.options.env ?? {};
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_998),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            stdinBuffer += new TextDecoder().decode(chunk);
            let newline = stdinBuffer.indexOf("\n");
            while (newline !== -1) {
              const line = stdinBuffer.slice(0, newline);
              stdinBuffer = stdinBuffer.slice(newline + 1);
              newline = stdinBuffer.indexOf("\n");
              if (line.length === 0) continue;
              const record = decodeJsonLine(line) as PiRpcRecord;
              allRequests.push(record);
              yield* Queue.offer(requests, record);
              const response = respond(record);
              if (response !== null) yield* emit(response);
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeRequest = (type: string) =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    emit,
    takeRequest,
    requestsOfType: (type: string) => allRequests.filter((record) => record["type"] === type),
    spawnEnv: () => spawnEnv,
    failNextModel: () => {
      failNextModel = true;
    },
    failNextThinking: () => {
      failNextThinking = true;
    },
  };
});
type FakePhi = Effect.Success<typeof makeFakePhi>;

const openPhi = Effect.fnUntraced(function* (fake: FakePhi) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const offers = yield* Queue.unbounded<ProviderContinuationRequest>();
  const adapter = yield* makePiAdapterV2({
    instanceId: PHI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "phi", launchArgs: "", customModels: [] },
    environment: {},
    sessionEnvironment: Effect.succeed({ FEADS_AGENT_TOKEN: "per-session-token" }),
    driver: PHI_PROVIDER,
    flavor: makePhiAdapterV2Flavor(idAllocator),
    continuationRequests: { offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid) },
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: selection("default"),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = <A extends ProviderAdapterV2Event>(
    predicate: (event: ProviderAdapterV2Event) => event is A,
  ) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: selection("default"),
    runtimePolicy,
  });
  return { runtime, providerThread, takeEvent, offers };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  input: {
    readonly ordinal: number;
    readonly model?: string;
    readonly message?: Partial<ProviderAdapterV2TurnMessage>;
  },
) {
  const now = yield* DateTime.now;
  const model = input.model ?? "default";
  const runId = RunId.make(`run:${THREAD_ID}:${input.ordinal}`);
  const appThread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:phi" as OrchestrationV2AppThread["projectId"],
    title: "Phi test thread",
    providerInstanceId: PHI_INSTANCE_ID,
    modelSelection: selection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal: input.ordinal,
    providerTurnOrdinal: input.ordinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: MessageId.make(`message:${THREAD_ID}:${input.ordinal}`),
      text: "Hello phi",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      ...input.message,
    },
    modelSelection: selection(model),
    runtimePolicy,
  });
  return runId;
});

const isTerminal = (
  event: ProviderAdapterV2Event,
): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
  event.type === "turn.terminal";
const isAssistantText =
  (text: string) =>
  (
    event: ProviderAdapterV2Event,
  ): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
    event.type === "turn_item.updated" &&
    event.turnItem.type === "assistant_message" &&
    event.turnItem.text === text &&
    event.turnItem.status === "completed";
const isQuestionOrWorkspaceState = (
  event: ProviderAdapterV2Event,
): event is Extract<
  ProviderAdapterV2Event,
  { type: "runtime_request.updated" | "turn_item.updated" }
> =>
  event.type === "runtime_request.updated" ||
  (event.type === "turn_item.updated" &&
    (event.turnItem.type === "user_input_request" || event.turnItem.type === "workspace_state"));
const isWorkspaceState = (
  event: ProviderAdapterV2Event,
): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
  event.type === "turn_item.updated" && event.turnItem.type === "workspace_state";

const assistantRun = (text: string): ReadonlyArray<PiRpcRecord> => [
  { type: "agent_start" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
  },
  { type: "message_end", message: { role: "assistant", content: [] } },
  { type: "agent_settled" },
];

const continuationMessage = {
  createdBy: "agent",
  creationSource: "provider",
} satisfies Partial<ProviderAdapterV2TurnMessage>;

describe("PhiAdapterV2", () => {
  it.effect("reads the per-session environment overlay at session open", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      yield* openPhi(fake);
      assert.equal(fake.spawnEnv()["FEADS_AGENT_TOKEN"], "per-session-token");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("passes captured login-shell Feads variables to a newly launched Phi session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const adapter = yield* PhiAdapterV2Driver.create({
        instanceId: PHI_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: PhiAdapterV2Driver.defaultConfig(),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: selection("default"),
        runtimePolicy,
      });

      assert.equal(fake.spawnEnv()["FEADS_AGENT_TOKEN"], "captured-login-shell-token");
      assert.equal(fake.spawnEnv()["FEADS_URL"], "https://feads.test.invalid");
      assert.equal(fake.spawnEnv()["LOGIN_ONLY_MCP_SETTING"], "captured");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          testLayer,
          HarnessLaunchEnvironment.layerTest({
            FEADS_AGENT_TOKEN: "captured-login-shell-token",
            FEADS_URL: "https://feads.test.invalid",
            LOGIN_ONLY_MCP_SETTING: "captured",
          }),
        ),
      ),
    ),
  );

  it.effect("does not pass captured Feads credentials when Phi opts out", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const adapter = yield* PhiAdapterV2Driver.create({
        instanceId: PHI_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: PhiAdapterV2Driver.defaultConfig(),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
      yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: selection("default"),
        runtimePolicy,
      });

      assert.equal(fake.spawnEnv()["PI_NO_FEADS"], "1");
      assert.equal(fake.spawnEnv()["FEADS_AGENT_TOKEN"], undefined);
      assert.equal(fake.spawnEnv()["FEADS_TOKEN"], undefined);
      assert.equal(fake.spawnEnv()["LOGIN_ONLY_MCP_SETTING"], "captured");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          testLayer,
          HarnessLaunchEnvironment.layerTest({
            PI_NO_FEADS: "1",
            FEADS_AGENT_TOKEN: "fake-login-token",
            FEADS_TOKEN: "fake-legacy-token",
            LOGIN_ONLY_MCP_SETTING: "captured",
          }),
        ),
      ),
    ),
  );

  it.effect("holds an unsolicited run and replays it in the continuation turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent, offers } = yield* openPhi(fake);

      for (const record of assistantRun("Background result")) yield* fake.emit(record);
      const offer = yield* Queue.take(offers);
      assert.equal(offer.threadId, THREAD_ID);
      assert.equal(offer.driver, PHI_PROVIDER);
      assert.equal(offer.delivery, "adapter_buffered");

      yield* startTurn(runtime, providerThread, { ordinal: 1, message: continuationMessage });
      const item = yield* takeEvent(isAssistantText("Background result"));
      assert.equal(item.turnItem.runId, RunId.make(`run:${THREAD_ID}:1`));
      const terminal = yield* takeEvent(isTerminal);
      assert.equal(terminal.status, "completed");
      // The continuation replays Phi's own run; it never prompts.
      assert.lengthOf(fake.requestsOfType("prompt"), 0);
      assert.lengthOf(fake.requestsOfType("set_session_name"), 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("joins a running unsolicited run as a follow-up and drops its continuation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent, offers } = yield* openPhi(fake);

      yield* fake.emit({ type: "agent_start" });
      const offer = yield* Queue.take(offers);

      yield* startTurn(runtime, providerThread, { ordinal: 1 });
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["streamingBehavior"], "steer");
      for (const record of assistantRun("Answer").slice(1)) yield* fake.emit(record);
      yield* takeEvent(isAssistantText("Answer"));
      assert.equal((yield* takeEvent(isTerminal)).status, "completed");

      // The user turn took the run, so its continuation dispatches nothing.
      assert.isDefined(offer.dispatchIfCurrent);
      const dispatched = yield* offer.dispatchIfCurrent!(Effect.succeed("dispatched"));
      assert.isTrue(Option.isNone(dispatched));

      // A continuation that still arrives finalizes without replaying anything.
      yield* startTurn(runtime, providerThread, { ordinal: 2, message: continuationMessage });
      assert.equal((yield* takeEvent(isTerminal)).status, "completed");
      assert.lengthOf(fake.requestsOfType("prompt"), 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps awaiting-human passive and carries its question in the settled item", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent } = yield* openPhi(fake);

      yield* startTurn(runtime, providerThread, { ordinal: 1 });
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "entry_appended",
        entry: {
          type: "custom",
          customType: "workspace-state",
          data: { end_state: "awaiting-human", question: "Ship it to prod?" },
        },
      });
      yield* fake.emit({ type: "agent_settled" });
      const state = yield* takeEvent(isQuestionOrWorkspaceState);
      assert.equal(state.type, "turn_item.updated");
      if (state.type === "turn_item.updated" && state.turnItem.type === "workspace_state") {
        assert.equal(state.turnItem.payload.endState, "awaiting-human");
        assert.equal(state.turnItem.payload.question, "Ship it to prod?");
      }
      const terminal = yield* takeEvent(
        (
          event,
        ): event is Extract<
          ProviderAdapterV2Event,
          { type: "turn.terminal" | "runtime_request.updated" | "turn_item.updated" }
        > => isTerminal(event) || isQuestionOrWorkspaceState(event),
      );
      assert.equal(terminal.type, "turn.terminal");

      // The ordinary reply starts a new Phi turn without expiring any request.
      yield* startTurn(runtime, providerThread, { ordinal: 2 });
      yield* fake.takeRequest("prompt");
      assert.lengthOf(fake.requestsOfType("prompt"), 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "replaces an earlier awaiting-human record with the later settled record in the same turn",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePhi;
        const { runtime, providerThread, takeEvent } = yield* openPhi(fake);
        yield* startTurn(runtime, providerThread, { ordinal: 1 });
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "entry_appended",
          entry: {
            type: "custom",
            customType: "workspace-state",
            data: { end_state: "awaiting-human", question: "Ship it to prod?" },
          },
        });
        yield* fake.emit({
          type: "entry_appended",
          entry: { type: "custom", customType: "workspace-state", data: { end_state: "complete" } },
        });
        yield* fake.emit({ type: "agent_settled" });
        const state = yield* takeEvent(isQuestionOrWorkspaceState);
        assert.equal(state.type, "turn_item.updated");
        if (state.type === "turn_item.updated" && state.turnItem.type === "workspace_state") {
          assert.equal(state.turnItem.payload.endState, "complete");
          assert.isUndefined(state.turnItem.payload.question);
        }
        const terminal = yield* takeEvent(
          (
            event,
          ): event is Extract<
            ProviderAdapterV2Event,
            { type: "turn.terminal" | "runtime_request.updated" | "turn_item.updated" }
          > => isTerminal(event) || isQuestionOrWorkspaceState(event),
        );
        assert.equal(terminal.type, "turn.terminal");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("persists the latest valid workspace state on each settled turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent } = yield* openPhi(fake);
      yield* startTurn(runtime, providerThread, { ordinal: 1 });
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "entry_appended",
        entry: { type: "custom", customType: "workspace-state", data: { end_state: "complete" } },
      });
      yield* fake.emit({
        type: "entry_appended",
        entry: {
          type: "custom",
          customType: "workspace-state",
          data: {
            version: 1,
            end_state: "mid-work",
            open_items: ["  Finish tests  ", "", 42, "Push the PR"],
            feads: { epic: "ex-123" },
            source: "tool",
          },
        },
      });
      yield* fake.emit({ type: "agent_settled" });
      const recorded = yield* takeEvent(isWorkspaceState);
      assert.equal(recorded.turnItem.type, "workspace_state");
      if (recorded.turnItem.type === "workspace_state") {
        assert.deepEqual(recorded.turnItem.payload, {
          endState: "mid-work",
          openItems: ["Finish tests", "Push the PR"],
          feadsEpic: "ex-123",
          recordedAt: DateTime.formatIso(recorded.turnItem.completedAt!),
        });
        assert.equal(recorded.turnItem.status, "completed");
        assert.equal(recorded.turnItem.threadId, THREAD_ID);
      }
      assert.equal((yield* takeEvent(isTerminal)).status, "completed");

      // A malformed record on the next settled turn never copies the previous one.
      yield* startTurn(runtime, providerThread, { ordinal: 2 });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "entry_appended",
        entry: { type: "custom", customType: "workspace-state", data: { end_state: "unknown" } },
      });
      yield* fake.emit({ type: "agent_settled" });
      const next = yield* takeEvent(
        (
          event,
        ): event is Extract<
          ProviderAdapterV2Event,
          { type: "turn.terminal" | "turn_item.updated" }
        > => isTerminal(event) || isWorkspaceState(event),
      );
      assert.equal(next.type, "turn.terminal");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("applies a live Phi picker change while the turn is still running", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent } = yield* openPhi(fake);
      yield* startTurn(runtime, providerThread, { ordinal: 1, model: "anthropic/claude-luna" });
      yield* fake.emit({ type: "agent_start" });
      yield* runtime.setModelSelection!(selection("anthropic/claude-opus"));
      const requests = fake.requestsOfType("set_model");
      assert.lengthOf(requests, 2);
      assert.equal(requests[1]?.["provider"], "anthropic");
      assert.equal(requests[1]?.["modelId"], "claude-opus");
      assert.equal(requests[1]?.["persist"], false);
      assert.lengthOf(fake.requestsOfType("prompt"), 1);
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent(isTerminal);
      yield* startTurn(runtime, providerThread, { ordinal: 2, model: "anthropic/claude-opus" });
      assert.lengthOf(fake.requestsOfType("set_model"), 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the previous applied model after a live RPC rejection", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent } = yield* openPhi(fake);
      yield* startTurn(runtime, providerThread, { ordinal: 1, model: "anthropic/claude-luna" });
      yield* fake.emit({ type: "agent_start" });
      fake.failNextModel();
      const result = yield* Effect.exit(
        runtime.setModelSelection!(selection("anthropic/claude-opus")),
      );
      assert.equal(result._tag, "Failure");
      assert.deepEqual(
        fake.requestsOfType("set_model").map((request) => request["modelId"]),
        ["claude-luna", "claude-opus", "claude-luna"],
      );
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent(isTerminal);
      yield* startTurn(runtime, providerThread, { ordinal: 2, model: "anthropic/claude-luna" });
      assert.lengthOf(fake.requestsOfType("set_model"), 3);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restores the old model when a live thinking update fails", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent } = yield* openPhi(fake);
      yield* startTurn(runtime, providerThread, { ordinal: 1, model: "anthropic/claude-luna" });
      yield* fake.emit({ type: "agent_start" });
      fake.failNextThinking();
      const result = yield* Effect.exit(
        runtime.setModelSelection!({
          ...selection("anthropic/claude-opus"),
          options: [{ id: "thinking", value: "low" }],
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.deepEqual(
        fake.requestsOfType("set_model").map((request) => request["modelId"]),
        ["claude-luna", "claude-opus", "claude-luna"],
      );
      assert.equal(fake.requestsOfType("set_thinking_level").at(-1)?.["level"], "high");
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent(isTerminal);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps Phi's MCP connection notices out of the timeline", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhi;
      const { runtime, providerThread, takeEvent } = yield* openPhi(fake);

      yield* startTurn(runtime, providerThread, { ordinal: 1, model: "anthropic/claude-a" });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "mcp-status",
        method: "notify",
        message: "mcp: monday needs an OAuth login, opening a browser.",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "other",
        method: "notify",
        message: "Context compacted",
      });
      const notice = yield* takeEvent(
        (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
      );
      assert.isTrue(
        notice.turnItem.type === "system_notice" && notice.turnItem.message === "Context compacted",
      );
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent(isTerminal);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "re-sends the thread's model after an error fallback but keeps a refusal escalation",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePhi;
        const { runtime, providerThread, takeEvent } = yield* openPhi(fake);
        const model = "anthropic/claude-a";

        yield* startTurn(runtime, providerThread, { ordinal: 1, model });
        const first = yield* fake.takeRequest("set_model");
        assert.equal(first["persist"], false);
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "error_fallback",
          from: model,
          to: "openai/gpt-b",
          reason: "overloaded",
        });
        const notice = yield* takeEvent(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        assert.isTrue(
          notice.turnItem.type === "system_notice" &&
            notice.turnItem.message.includes("Phi rerouted to openai/gpt-b") &&
            notice.turnItem.id.length > 0,
        );
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent(isTerminal);

        yield* startTurn(runtime, providerThread, { ordinal: 2, model });
        const reasserted = yield* fake.takeRequest("set_model");
        assert.equal(reasserted["provider"], "anthropic");
        assert.equal(reasserted["modelId"], "claude-a");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "refusal_fallback", from: model, to: "openai/gpt-c" });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent(isTerminal);

        // Turn 2's prompt is still queued behind its set_model; turn 3 sends none.
        yield* startTurn(runtime, providerThread, { ordinal: 3, model });
        yield* fake.takeRequest("prompt");
        yield* fake.takeRequest("prompt");
        assert.lengthOf(fake.requestsOfType("set_model"), 2);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
