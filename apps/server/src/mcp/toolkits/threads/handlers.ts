// Exowatt distro: handlers for the Threads coordination toolkit, on
// orchestration v2.
//
// Every read is a projection of the v2 thread shell (plus the projection
// records it needs); every mutation is one v2 command or one
// ThreadManagement/ThreadLaunch/Project service call, stamped `createdBy:
// "agent"`, `creationSource: "mcp"` and, when the caller is a thread, that
// thread as `senderThreadId`. `thread_listen` is the push half of "push, not
// poll": it parks on the v2 domain-event stream and returns only when the
// watched thread reaches a milestone.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous ids for P3 commands and messages.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure path comparison for a peer's worktreePath.
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EXOWATT_THREADS_MCP_CAPABILITY,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProviderUserInputAnswers,
  type ThreadId,
  type ThreadsCreateProjectInput,
  type ThreadsCreateProjectResult,
  type ThreadsCreateThreadInput,
  type ThreadsCreateThreadResult,
  type ThreadsDeleteProjectInput,
  type ThreadsDeleteThreadInput,
  type ThreadsDiffInput,
  type ThreadsDiffResult,
  type ThreadsEnvironmentListResult,
  type ThreadsForwardInput,
  type ThreadsForwardResult,
  type ThreadsInterruptInput,
  type ThreadsLatestRun,
  type ThreadsListenInput,
  type ThreadsListenResult,
  type ThreadsMilestone,
  type ThreadsMutationResult,
  type ThreadsPendingRequest,
  type ThreadsPinInput,
  type ThreadsPinReorderInput,
  type ThreadsProjectListInput,
  type ThreadsProjectListResult,
  type ThreadsProjectMutationResult,
  type ThreadsRespondInput,
  type ThreadsRevertInput,
  type ThreadsSearchInput,
  type ThreadsSearchResult,
  type ThreadsSnoozeInput,
  type ThreadsSummariesInput,
  type ThreadsSummariesResult,
  type ThreadsSummariesToolResult,
  type ThreadsTaskCompletion,
  type ThreadsThreadDetail,
  type ThreadsThreadListInput,
  type ThreadsThreadListResult,
  type ThreadsThreadState,
  type ThreadsThreadStatus,
  type ThreadsThreadSummary,
  type ThreadsThreadTargetInput,
  ThreadsToolError,
  type ThreadsToolName,
  type ThreadsTranscriptInput,
  type ThreadsTranscriptMessage,
  type ThreadsTranscriptResult,
  type ThreadsUpdateInput,
  type ThreadsUpdateProjectInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PeerEnvironments from "../../../exowattPeerEnvironments/PeerEnvironments.ts";
import * as PeerGate from "../../../exowattPeerEnvironments/PeerGate.ts";
import {
  DispatchModeLimit,
  lowerRuntimeMode,
} from "../../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import { userFacingDispatchErrorMessage } from "../../../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { forwardable, PEER_LISTEN_GRACE_MS } from "./forwarding.ts";
import {
  ProjectListTool,
  ThreadCreateTool,
  ThreadDetailTool,
  ThreadForwardTool,
  ThreadListenTool,
  ThreadListTool,
  ThreadSearchTool,
  ThreadStatusTool,
  ThreadSummariesTool,
  ThreadsToolkit,
  ThreadTranscriptTool,
} from "./tools.ts";

/** Longest a single `thread_listen` call blocks before returning `timeout`. */
export const THREADS_LISTEN_MAX_MS = 10 * 60 * 1_000;
/** Re-read the shell this often even without an event, in case one was missed. */
const LISTEN_SAFETY_POLL_MS = 30_000;
const MAX_DERIVED_TITLE_LENGTH = 80;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_TRANSCRIPT_TURNS = 10;
const DEFAULT_SUMMARY_LIMIT = 20;
const DEFAULT_MAX_CHARS = 4_000;
/** A patch is the one read here that can be arbitrarily large. */
const DEFAULT_DIFF_MAX_CHARS = 20_000;
const ACTIVE_THREAD_STATES: ReadonlyArray<ThreadsThreadState> = [
  "running",
  "needs-you",
  "failed",
  "finished",
  "idle",
];
const RUNNING_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

type Deps =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagement.ThreadManagementService
  | ThreadLaunch.ThreadLaunchService
  | ThreadSearch.ThreadSearch
  | ProjectService.ProjectService
  | CheckpointDiffQuery.CheckpointDiffQuery
  | ServerEnvironment.ServerEnvironment
  | PeerEnvironments.PeerEnvironments;

type Shell = OrchestrationV2ThreadShell;

const iso = (value: DateTime.DateTime) => DateTime.formatIso(value);
const isoOrNull = (value: DateTime.DateTime | null | undefined) =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

// Pure projections, shared by the tools and their tests.

/** Mirrors the client shell model: any pending request except a user question or auth refresh. */
const hasPendingApprovals = (shell: Shell) =>
  shell.pendingRuntimeRequest !== null &&
  shell.pendingRuntimeRequest.kind !== "user_input" &&
  shell.pendingRuntimeRequest.kind !== "auth_refresh";
const hasPendingUserInput = (shell: Shell) => shell.pendingRuntimeRequest?.kind === "user_input";
const hasPhiHandback = (shell: Shell) =>
  shell.latestWorkspaceState?.endState === "awaiting-human" &&
  (shell.activityRunStatus ?? null) === null &&
  !RUNNING_STATUSES.has(shell.status);

/**
 * Where a thread stands from an agent's point of view. Pure, so the tests and
 * `thread_listen` share one definition of "milestone".
 */
export function threadsThreadState(shell: Shell): ThreadsThreadState {
  if (shell.archivedAt !== null) return "archived";
  if (
    hasPendingApprovals(shell) ||
    hasPendingUserInput(shell) ||
    hasPhiHandback(shell) ||
    shell.hasActionableProposedPlan
  ) {
    return "needs-you";
  }
  if ((shell.activityRunStatus ?? null) !== null || RUNNING_STATUSES.has(shell.status)) {
    return "running";
  }
  if (shell.status === "failed") return "failed";
  if (shell.status === "completed") return "finished";
  return "idle";
}

export function threadsLatestRun(shell: Shell): ThreadsLatestRun | null {
  if (shell.latestRunId === null) return null;
  return {
    runId: shell.latestRunId,
    status: shell.status,
    requestedAt: isoOrNull(shell.latestRunRequestedAt),
    startedAt: isoOrNull(shell.latestRunStartedAt),
    completedAt: isoOrNull(shell.latestRunCompletedAt),
  };
}

export function threadsThreadSummary(shell: Shell): ThreadsThreadSummary {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    state: threadsThreadState(shell),
    latestRun: threadsLatestRun(shell),
    lastError: shell.lastError ?? null,
    hasPendingApprovals: hasPendingApprovals(shell),
    hasPendingUserInput: hasPendingUserInput(shell),
    hasActionableProposedPlan: shell.hasActionableProposedPlan,
    providerInstanceId: shell.providerInstanceId,
    model: shell.modelSelection.model,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    settled: shell.settledOverride === "settled",
    settledAt: shell.settledOverride === "settled" ? isoOrNull(shell.settledAt) : null,
    settledOverride: shell.settledOverride,
    updatedAt: iso(shell.updatedAt),
  };
}

export function threadsThreadStatus(
  shell: Shell,
  pendingRequests: ReadonlyArray<ThreadsPendingRequest> = [],
): ThreadsThreadStatus {
  return { ...threadsThreadSummary(shell), pendingRequests };
}

/**
 * The shell as the thread header and sidebar row see it. `pinned`, `settled`
 * and `archived` are the derived booleans the UI renders, not the raw stamps.
 */
export function threadsThreadDetail(
  shell: Shell,
  pendingRequests: ReadonlyArray<ThreadsPendingRequest> = [],
): ThreadsThreadDetail {
  return {
    ...threadsThreadStatus(shell, pendingRequests),
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pinned: (shell.pinnedAt ?? null) !== null,
    pinOrderKey: shell.pinOrderKey ?? null,
    snoozedUntil: isoOrNull(shell.snoozedUntil),
    archived: shell.archivedAt !== null,
    createdAt: iso(shell.createdAt),
  };
}

export function truncateText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

const nonEmpty = (value: string | undefined | null): value is string =>
  value !== undefined && value !== null && value.trim().length > 0;

/**
 * The approvals and questions a thread is still waiting on, in the words it
 * used: pending runtime requests joined to the request items that carry the
 * prompt. Same join as the client's `derivePendingThreadRequests`.
 */
export function threadsPendingRequests(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): ReadonlyArray<ThreadsPendingRequest> {
  const requests: ThreadsPendingRequest[] = [];
  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      requests.push({
        requestId: request.id,
        kind: "question",
        prompt:
          item.questions.length > 0
            ? item.questions.map((question) => question.question).join("\n")
            : "Question asked",
        options: item.questions.flatMap((question) =>
          question.options.map((option) => option.label),
        ),
        questionIds: item.questions.map((question) => question.id),
      });
      continue;
    }
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    const approval = item?.type === "approval_request" ? item : undefined;
    requests.push({
      requestId: request.id,
      kind: "approval",
      prompt:
        [approval?.prompt, approval?.appName, approval?.title].find(nonEmpty)?.trim() ??
        `Approval requested (${request.kind})`,
      options: (approval?.options ?? []).map((option) => option.label),
      questionIds: [],
    });
  }
  return requests;
}

/**
 * Re-key an agent's answers onto the question ids the thread actually used.
 * Ids that already match pass through; an unknown key lands on the id it names
 * case-insensitively, or on the only question when there is just one.
 */
export function threadsNormalizeAnswers(
  answers: ProviderUserInputAnswers,
  request: ThreadsPendingRequest,
): ProviderUserInputAnswers {
  const ids = request.questionIds;
  if (ids.length === 0) return answers;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (ids.includes(key)) {
      normalized[key] = value;
      continue;
    }
    const byName = ids.find((id) => id.toLowerCase() === key.toLowerCase());
    const target = byName ?? (ids.length === 1 ? ids[0] : undefined);
    normalized[target ?? key] = value;
  }
  return normalized;
}

/** A listener returns on these; `running`/`idle` keep it attached. */
export function threadsMilestone(
  state: ThreadsThreadState,
): Exclude<ThreadsMilestone, "timeout"> | null {
  switch (state) {
    case "finished":
    case "archived":
      return "finished";
    case "needs-you":
      return "needs-you";
    case "failed":
      return "failed";
    case "running":
    case "idle":
      return null;
  }
}

/**
 * The one line a listener reports: the milestone first, then the thread, then
 * only what the user needs to act on.
 */
export function threadsListenSummary(
  milestone: ThreadsMilestone,
  status: ThreadsThreadStatus,
): string {
  const head = `${milestone}: "${status.title}"`;
  switch (milestone) {
    case "needs-you": {
      const waiting = status.hasPendingApprovals
        ? "waiting for an approval"
        : status.hasPendingUserInput
          ? "waiting for an answer"
          : status.pendingRequests.some((request) => request.kind === "handback")
            ? "waiting for your reply (use thread_forward)"
            : "has a plan to review";
      const asked = status.pendingRequests
        .map((request) =>
          request.options.length > 0
            ? `${request.prompt} (${request.options.join(" / ")})`
            : request.prompt,
        )
        .join("; ");
      return asked.length > 0 ? `${head}: ${waiting}: ${asked}` : `${head}: ${waiting}`;
    }
    case "failed":
      return status.lastError
        ? `${head}: ${status.lastError}`
        : `${head}: the last run ended in an error`;
    case "timeout":
      return `${head}: still ${status.state}, no milestone yet`;
    case "finished":
      return head;
  }
}

/** First line of the request, trimmed to a sidebar-sized title. */
export function deriveThreadTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "New thread";
  if (firstLine.length <= MAX_DERIVED_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_DERIVED_TITLE_LENGTH - 1).trimEnd()}…`;
}

const TASK_COMPLETION_STATUS: Partial<
  Record<OrchestrationV2Subagent["status"], ThreadsTaskCompletion["status"]>
> = {
  completed: "completed",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

/** Subagents that finished, newest first, with the result they reported. */
export function threadsTaskCompletions(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  options: { readonly limit: number; readonly maxChars: number },
): ReadonlyArray<ThreadsTaskCompletion> {
  return subagents
    .flatMap((subagent) => {
      const status = TASK_COMPLETION_STATUS[subagent.status];
      if (status === undefined) return [];
      const finishedAt = subagent.completedAt ?? subagent.updatedAt;
      return [
        {
          taskId: subagent.id,
          status,
          title: subagent.title,
          summary:
            subagent.result === null ? null : truncateText(subagent.result, options.maxChars).text,
          childThreadId: subagent.childThreadId,
          runId: subagent.runId,
          createdAt: iso(finishedAt),
        } satisfies ThreadsTaskCompletion,
      ];
    })
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, options.limit);
}

/**
 * One page of the transcript: the newest `turnLimit` turns strictly before
 * `beforeCursor` (a message id), oldest first. A turn starts at a user
 * message; anything before the first user message is its own turn.
 */
export function threadsTranscriptPage(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  options: {
    readonly turnLimit: number;
    readonly beforeCursor: string | undefined;
    readonly maxChars: number;
  },
): {
  readonly messages: ReadonlyArray<ThreadsTranscriptMessage>;
  readonly beforeCursor: string | null;
  readonly hasMore: boolean;
} {
  const ordered = messages.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
  );
  const cursorIndex =
    options.beforeCursor === undefined
      ? ordered.length
      : ordered.findIndex((message) => message.id === options.beforeCursor);
  const end = cursorIndex === -1 ? 0 : cursorIndex;
  let start = end;
  let turns = 0;
  for (let index = end - 1; index >= 0 && turns < options.turnLimit; index -= 1) {
    if (ordered[index]!.role === "user") {
      turns += 1;
      start = index;
    }
  }
  // Fewer turns than asked for: the page reaches back to the first message.
  if (turns < options.turnLimit) start = 0;
  const page = ordered.slice(start, end);
  return {
    messages: page.map((message) => {
      const bounded = truncateText(message.text, options.maxChars);
      return {
        messageId: message.id,
        role: message.role,
        text: bounded.text,
        truncated: bounded.truncated,
        runId: message.runId,
        streaming: message.streaming,
        createdBy: message.createdBy,
        senderThreadId: message.senderThreadId ?? null,
        createdAt: iso(message.createdAt),
      };
    }),
    beforeCursor: start > 0 ? (ordered[start]?.id ?? null) : null,
    hasMore: start > 0,
  };
}

/** The checkpoint range one `thread_diff` call resolves to. */
export interface ThreadsDiffRange {
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly full: boolean;
}

/**
 * Resolve the three accepted input forms onto one range, or say why the input
 * is ambiguous. Pure, so the rules are tested without a checkpoint store.
 */
export function threadsDiffRange(
  input: ThreadsDiffInput,
): ThreadsDiffRange | { readonly error: string } {
  if (input.full === true) {
    if (input.fromTurnCount !== undefined) {
      return {
        error:
          "full: true always starts at the thread's first turn; drop fromTurnCount or drop full",
      };
    }
    const toTurnCount = input.toTurnCount ?? input.turnCount;
    if (toTurnCount === undefined) {
      return { error: "pass toTurnCount (or turnCount) alongside full: true" };
    }
    return { fromTurnCount: 0, toTurnCount, full: true };
  }
  if (input.turnCount !== undefined) {
    if (input.fromTurnCount !== undefined || input.toTurnCount !== undefined) {
      return {
        error:
          "pass either turnCount (one turn) or fromTurnCount + toTurnCount (a range), not both",
      };
    }
    return { fromTurnCount: input.turnCount - 1, toTurnCount: input.turnCount, full: false };
  }
  if (input.fromTurnCount === undefined || input.toTurnCount === undefined) {
    return {
      error:
        "pass turnCount for one turn, fromTurnCount + toTurnCount for a range, or full: true with toTurnCount",
    };
  }
  if (input.fromTurnCount > input.toTurnCount) {
    return { error: "fromTurnCount must be less than or equal to toTurnCount" };
  }
  return { fromTurnCount: input.fromTurnCount, toTurnCount: input.toTurnCount, full: false };
}

// Effectful helpers.

const toolError = (tool: ThreadsToolName, threadId: ThreadId | null, detail: string) =>
  new ThreadsToolError({ tool, threadId, detail });

/**
 * The reason a caller can act on. Orchestrator errors wrap the real cause
 * ("has a queued message…") behind a generic "Failed to dispatch…" message, so
 * prefer the user-facing cause the web client and the t3-code MCP show.
 */
const describe = (cause: unknown): string =>
  userFacingDispatchErrorMessage(cause) ??
  (cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause));

const failWith =
  (tool: ThreadsToolName, threadId: ThreadId | null) =>
  (cause: unknown): ThreadsToolError =>
    toolError(tool, threadId, describe(cause));

const newCommandId = (tag: string) =>
  Effect.sync(() => CommandId.make(`mcp:threads:${tag}:${NodeCrypto.randomUUID()}`));

const requireCapability = Effect.fn("ThreadsToolkit.requireCapability")(function* (
  tool: ThreadsToolName,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
    return yield* toolError(
      tool,
      null,
      `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability.`,
    );
  }
  return invocation;
});

/** Agent provenance for everything these tools create; the caller thread, when there is one. */
const provenance = (invocation: McpInvocationContext.McpInvocationScope) => {
  const senderThreadId = McpInvocationContext.callerThreadId(invocation);
  return {
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    ...(senderThreadId === null ? {} : { senderThreadId }),
  };
};

/**
 * `confirm: true` is a schema literal, so it cannot be omitted; this guards
 * the value a hand-built payload could still get wrong.
 */
const requireConfirmed = (tool: ThreadsToolName, threadId: ThreadId | null, confirm: boolean) =>
  confirm === true
    ? Effect.void
    : toolError(tool, threadId, "pass confirm: true to carry out this irreversible action");

const readShell = Effect.fn("ThreadsToolkit.readShell")(function* (
  tool: ThreadsToolName,
  threadId: ThreadId,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(threadId)
    .pipe(Effect.mapError(failWith(tool, threadId)));
  if (shell === null || shell.deletedAt !== null) {
    return yield* toolError(tool, threadId, "thread not found");
  }
  return shell;
});

const readRecords = Effect.fn("ThreadsToolkit.readRecords")(function* <
  K extends Parameters<
    ThreadManagement.ThreadManagementService["Service"]["getProjectThreadRecords"]
  >[1][number],
>(
  tool: ThreadsToolName,
  shell: Shell,
  fields: ReadonlyArray<K>,
  filter?: Parameters<
    ThreadManagement.ThreadManagementService["Service"]["getProjectThreadRecords"]
  >[2],
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return yield* threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId: shell.id }, fields, filter)
    .pipe(Effect.mapError(failWith(tool, shell.id)));
});

/**
 * The thread's open approvals and questions. Skipped unless the shell says
 * something is pending, so `thread_listen`'s re-reads stay cheap.
 */
const readPendingRequests = (tool: ThreadsToolName, shell: Shell) => {
  const handback: ReadonlyArray<ThreadsPendingRequest> = hasPhiHandback(shell)
    ? [
        {
          kind: "handback",
          prompt:
            shell.latestWorkspaceState?.question?.trim() || "Phi is waiting on your decision.",
          options: [],
          questionIds: [],
        },
      ]
    : [];
  return shell.pendingRuntimeRequest === null
    ? Effect.succeed(handback)
    : readRecords(tool, shell, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["approval_request", "user_input_request"],
      }).pipe(Effect.map((projection) => [...threadsPendingRequests(projection), ...handback]));
};

const readStatus = Effect.fn("ThreadsToolkit.readStatus")(function* (
  tool: ThreadsToolName,
  threadId: ThreadId,
) {
  const shell = yield* readShell(tool, threadId);
  return { shell, status: threadsThreadStatus(shell, yield* readPendingRequests(tool, shell)) };
});

const dispatch = Effect.fn("ThreadsToolkit.dispatch")(function* (
  tool: ThreadsToolName,
  threadId: ThreadId | null,
  command: OrchestrationV2ServerCommand,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return yield* threads.dispatch(command).pipe(Effect.mapError(failWith(tool, threadId)));
});

/** One thread command; returns the thread and the sequence it produced. */
const threadCommand = Effect.fn("ThreadsToolkit.threadCommand")(function* (
  tool: ThreadsToolName,
  threadId: ThreadId,
  makeCommand: (commandId: CommandId) => OrchestrationV2ServerCommand,
) {
  yield* readShell(tool, threadId);
  const { sequence } = yield* dispatch(
    tool,
    threadId,
    makeCommand(yield* newCommandId(tool.replace(/^thread_/, ""))),
  );
  return { threadId, sequence } satisfies ThreadsMutationResult;
});

// Projects.

const projectList = Effect.fn("ThreadsToolkit.project_list")(function* (
  _input: ThreadsProjectListInput,
): Effect.fn.Return<ThreadsProjectListResult, ThreadsToolError, Deps> {
  yield* requireCapability("project_list");
  const projects = yield* ProjectService.ProjectService;
  const shells = yield* projects.listShells().pipe(Effect.mapError(failWith("project_list", null)));
  return {
    projects: shells.map((project) => ({
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      updatedAt: project.updatedAt,
    })),
  };
});

const projectCreate = Effect.fn("ThreadsToolkit.project_create")(function* (
  input: ThreadsCreateProjectInput,
): Effect.fn.Return<ThreadsCreateProjectResult, ThreadsToolError, Deps> {
  yield* requireCapability("project_create");
  const projects = yield* ProjectService.ProjectService;
  // ProjectService normalizes the workspace root (`~`, absolute path,
  // existence, optional create) the same way the WebSocket path does.
  const project = yield* projects
    .create({
      commandId: yield* newCommandId("project-create"),
      projectId: ProjectId.make(NodeCrypto.randomUUID()),
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing === true,
      ...(input.defaultModelSelection === undefined
        ? {}
        : { defaultModelSelection: input.defaultModelSelection }),
    })
    .pipe(Effect.mapError(failWith("project_create", null)));
  return { projectId: project.id, title: project.title, workspaceRoot: project.workspaceRoot };
});

const projectUpdate = Effect.fn("ThreadsToolkit.project_update")(function* (
  input: ThreadsUpdateProjectInput,
): Effect.fn.Return<ThreadsProjectMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("project_update");
  const { projectId, ...patch } = input;
  if (Object.values(patch).every((value) => value === undefined)) {
    return yield* toolError(
      "project_update",
      null,
      `pass at least one of title, workspaceRoot, defaultModelSelection, defaultThreadEnvMode, faviconPath, scripts (project ${projectId})`,
    );
  }
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects
    .update({
      commandId: yield* newCommandId("project-update"),
      projectId,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.workspaceRoot === undefined ? {} : { workspaceRoot: patch.workspaceRoot }),
      ...(patch.defaultModelSelection === undefined
        ? {}
        : { defaultModelSelection: patch.defaultModelSelection }),
      ...(patch.defaultThreadEnvMode === undefined
        ? {}
        : { defaultThreadEnvMode: patch.defaultThreadEnvMode }),
      ...(patch.faviconPath === undefined ? {} : { faviconPath: patch.faviconPath }),
      ...(patch.scripts === undefined ? {} : { scripts: patch.scripts }),
    })
    .pipe(Effect.mapError(failWith("project_update", null)));
  return { projectId: project.id, title: project.title, workspaceRoot: project.workspaceRoot };
});

const projectDelete = Effect.fn("ThreadsToolkit.project_delete")(function* (
  input: ThreadsDeleteProjectInput,
): Effect.fn.Return<ThreadsProjectMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("project_delete");
  yield* requireConfirmed("project_delete", null, input.confirm);
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects
    .delete({
      commandId: yield* newCommandId("project-delete"),
      projectId: input.projectId,
      ...(input.force === undefined ? {} : { force: input.force }),
    })
    .pipe(Effect.mapError(failWith("project_delete", null)));
  return { projectId: project.id, title: project.title, workspaceRoot: project.workspaceRoot };
});

// Thread reads.

const threadList = Effect.fn("ThreadsToolkit.thread_list")(function* (
  input: ThreadsThreadListInput,
): Effect.fn.Return<ThreadsThreadListResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_list");
  // Capture the read boundary before loading the snapshot, so a caller can
  // pass it back as `updatedAfter` without missing updates made meanwhile.
  const serverTime = iso(yield* DateTime.now);
  const updatedAfterMs =
    input.updatedAfter === undefined ? undefined : Date.parse(input.updatedAfter);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const states = new Set<ThreadsThreadState>(input.state ?? ACTIVE_THREAD_STATES);
  // Archived shells live in their own snapshot; only read it when asked.
  const wantsActive = ACTIVE_THREAD_STATES.some((state) => states.has(state));
  const active = wantsActive
    ? yield* threads.getShellSnapshot().pipe(Effect.mapError(failWith("thread_list", null)))
    : null;
  const archived = states.has("archived")
    ? yield* threads
        .getShellSnapshot({ location: "archive" })
        .pipe(Effect.mapError(failWith("thread_list", null)))
    : null;
  const shells = [
    ...(active?.threads ?? []),
    ...(archived?.archivedThreads ?? []),
    ...(archived?.threads.filter((shell) => shell.archivedAt !== null) ?? []),
  ];
  const seen = new Set<ThreadId>();
  const matched = shells
    .filter((shell) => {
      if (seen.has(shell.id) || shell.deletedAt !== null) return false;
      seen.add(shell.id);
      return true;
    })
    .filter((shell) => input.projectId === undefined || shell.projectId === input.projectId)
    .filter(
      (shell) =>
        input.includeSubagents === true || shell.lineage.relationshipToParent !== "subagent",
    )
    .map(threadsThreadSummary)
    .filter((summary) => states.has(summary.state))
    .filter((summary) => input.includeSettled !== false || !summary.settled)
    .filter(
      (summary) =>
        updatedAfterMs === undefined ||
        [summary.updatedAt, summary.latestRun?.requestedAt, summary.latestRun?.completedAt].some(
          (timestamp) =>
            timestamp !== undefined && timestamp !== null && Date.parse(timestamp) > updatedAfterMs,
        ),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  return {
    threads: matched.slice(0, limit),
    total: matched.length,
    hasMore: matched.length > limit,
    updatedAfter: input.updatedAfter ?? null,
    serverTime,
  };
});

const threadTranscript = Effect.fn("ThreadsToolkit.thread_transcript")(function* (
  input: ThreadsTranscriptInput,
): Effect.fn.Return<ThreadsTranscriptResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_transcript");
  const shell = yield* readShell("thread_transcript", input.threadId);
  const records = yield* readRecords("thread_transcript", shell, ["messages"]);
  if (
    input.beforeCursor !== undefined &&
    !records.messages.some((message) => message.id === input.beforeCursor)
  ) {
    return yield* toolError("thread_transcript", shell.id, "unknown beforeCursor");
  }
  const page = threadsTranscriptPage(records.messages, {
    turnLimit: input.turnLimit ?? DEFAULT_TRANSCRIPT_TURNS,
    beforeCursor: input.beforeCursor,
    maxChars: input.maxChars ?? DEFAULT_MAX_CHARS,
  });
  return {
    threadId: shell.id,
    title: shell.title,
    state: threadsThreadState(shell),
    messages: page.messages,
    page: { beforeCursor: page.beforeCursor, hasMore: page.hasMore },
  };
});

const summarizeThread = Effect.fn("ThreadsToolkit.summarizeThread")(function* (
  threadId: ThreadId,
  limit: number,
  maxChars: number,
) {
  const shell = yield* readShell("thread_summaries", threadId);
  const { subagents } = yield* readRecords("thread_summaries", shell, ["subagents"]);
  const messages =
    shell.latestRunId === null
      ? []
      : (yield* readRecords("thread_summaries", shell, ["messages"], {
          messageRoles: ["assistant"],
          messageRunIds: [shell.latestRunId],
        })).messages;
  // The run's final assistant message once it settled; while it is still
  // streaming, the latest assistant message of that run.
  const latestAssistant =
    shell.latestRunId === null
      ? undefined
      : messages.findLast(
          (message) => message.role === "assistant" && message.runId === shell.latestRunId,
        );
  const latestText =
    latestAssistant === undefined ? null : truncateText(latestAssistant.text, maxChars);
  return {
    threadId: shell.id,
    title: shell.title,
    state: threadsThreadState(shell),
    latestRun: threadsLatestRun(shell),
    latestAssistantText: latestText?.text ?? null,
    latestAssistantTruncated: latestText?.truncated ?? false,
    taskCompletions: threadsTaskCompletions(subagents, { limit, maxChars }),
  } satisfies ThreadsSummariesResult;
});

const threadSummaries = Effect.fn("ThreadsToolkit.thread_summaries")(function* (
  input: ThreadsSummariesInput,
): Effect.fn.Return<ThreadsSummariesToolResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_summaries");
  const limit = input.limit ?? DEFAULT_SUMMARY_LIMIT;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  if (input.threadIds !== undefined) {
    // Atomic: one missing thread fails the batch.
    const summaries = yield* Effect.forEach(input.threadIds, (threadId) =>
      summarizeThread(threadId, limit, maxChars),
    );
    return { summaries };
  }
  if (input.threadId === undefined) {
    return yield* toolError("thread_summaries", null, "pass threadId or threadIds");
  }
  return yield* summarizeThread(input.threadId, limit, maxChars);
});

const threadStatus = Effect.fn("ThreadsToolkit.thread_status")(function* (
  input: ThreadsThreadTargetInput,
): Effect.fn.Return<ThreadsThreadStatus, ThreadsToolError, Deps> {
  yield* requireCapability("thread_status");
  return (yield* readStatus("thread_status", input.threadId)).status;
});

const threadDetail = Effect.fn("ThreadsToolkit.thread_detail")(function* (
  input: ThreadsThreadTargetInput,
): Effect.fn.Return<ThreadsThreadDetail, ThreadsToolError, Deps> {
  yield* requireCapability("thread_detail");
  const shell = yield* readShell("thread_detail", input.threadId);
  return threadsThreadDetail(shell, yield* readPendingRequests("thread_detail", shell));
});

const threadSearch = Effect.fn("ThreadsToolkit.thread_search")(function* (
  input: ThreadsSearchInput,
): Effect.fn.Return<ThreadsSearchResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_search");
  const search = yield* ThreadSearch.ThreadSearch;
  const result = yield* search
    .search({ query: input.query, ...(input.limit === undefined ? {} : { limit: input.limit }) })
    .pipe(Effect.mapError(failWith("thread_search", null)));
  return { matches: result.matches };
});

const threadDiff = Effect.fn("ThreadsToolkit.thread_diff")(function* (
  input: ThreadsDiffInput,
): Effect.fn.Return<ThreadsDiffResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_diff");
  const range = threadsDiffRange(input);
  if ("error" in range) {
    return yield* toolError("thread_diff", input.threadId, range.error);
  }
  yield* readShell("thread_diff", input.threadId);
  const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const whitespace =
    input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace };
  const result = yield* (
    range.full
      ? diffs.getFullThreadDiff({
          threadId: input.threadId,
          toTurnCount: range.toTurnCount,
          ...whitespace,
        })
      : diffs.getTurnDiff({
          threadId: input.threadId,
          fromTurnCount: range.fromTurnCount,
          toTurnCount: range.toTurnCount,
          ...whitespace,
        })
  ).pipe(Effect.mapError(failWith("thread_diff", input.threadId)));
  const bounded = truncateText(result.diff, input.maxChars ?? DEFAULT_DIFF_MAX_CHARS);
  return {
    threadId: input.threadId,
    fromTurnCount: result.fromTurnCount,
    toTurnCount: result.toTurnCount,
    full: range.full,
    diff: bounded.text,
    truncated: bounded.truncated,
  };
});

// Thread mutations.

const PEER_INBOUND_SETTING =
  "Settings › Sharing & access › Agents from my other environments may act here";

/**
 * A *reverse* linked environment's ceiling on this server (`exowattPeerInbound`), null for
 * every other caller including a forward peer session, which carries no ceiling at all (the
 * pre-reverse-links behaviour). Enforced here, on the receiver, whatever mode the sender asked.
 */
const peerRuntimeCeiling = (
  tool: ThreadsToolName,
  invocation: McpInvocationContext.McpInvocationScope,
) => {
  const session = invocation.environmentSession;
  if (session?.peer !== true || session.gated !== true) return Effect.succeed(null);
  return session.peerCeiling === undefined
    ? Effect.fail(
        toolError(
          tool,
          null,
          `agents from other environments are off here (${PEER_INBOUND_SETTING})`,
        ),
      )
    : Effect.succeed(session.peerCeiling);
};

const threadForward = Effect.fn("ThreadsToolkit.thread_forward")(function* (
  input: ThreadsForwardInput,
): Effect.fn.Return<ThreadsForwardResult, ThreadsToolError, Deps> {
  const invocation = yield* requireCapability("thread_forward");
  if (input.threadId === McpInvocationContext.callerThreadId(invocation)) {
    return yield* toolError(
      "thread_forward",
      input.threadId,
      "a thread cannot forward a message to itself",
    );
  }
  const target = yield* readShell("thread_forward", input.threadId);
  if (target.archivedAt !== null) {
    return yield* toolError("thread_forward", input.threadId, "the thread is archived");
  }
  const ceiling = yield* peerRuntimeCeiling("thread_forward", invocation);
  if (ceiling !== null && lowerRuntimeMode(target.runtimeMode, ceiling) !== target.runtimeMode) {
    return yield* toolError(
      "thread_forward",
      input.threadId,
      `the thread runs at ${target.runtimeMode}, above the ${ceiling} this environment allows agents from your other environments; raise it in ${PEER_INBOUND_SETTING}`,
    );
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  // A peer's id prefix lets the gate cancel it while queued and re-check it at start.
  const messageId =
    ceiling === null
      ? MessageId.make(NodeCrypto.randomUUID())
      : PeerGate.makePeerMessageId(NodeCrypto.randomUUID());
  // `queue` starts the turn on an idle thread and lines it up behind a
  // running one, which is what forwarding always meant.
  const result = yield* threads
    .sendToThread({
      projectId: target.projectId,
      commandId: yield* newCommandId("forward"),
      threadId: input.threadId,
      messageId,
      text: input.text,
      attachments: [],
      mode: "queue",
      ...provenance(invocation),
    })
    .pipe(
      // Rechecked under the thread's command lock, in case the user raised its mode meanwhile.
      ceiling === null
        ? (effect) => effect
        : Effect.provideService(DispatchModeLimit, {
            runtimeMode: ceiling,
            interactionMode: "default",
          }),
      Effect.mapError(failWith("thread_forward", input.threadId)),
    );
  return {
    threadId: input.threadId,
    messageId: result.message.id,
    runId: result.run.id,
    delivery: result.delivery,
    sequence: result.dispatch.sequence,
  };
});

const threadCreate = Effect.fn("ThreadsToolkit.thread_create")(function* (
  input: ThreadsCreateThreadInput,
): Effect.fn.Return<ThreadsCreateThreadResult, ThreadsToolError, Deps> {
  const invocation = yield* requireCapability("thread_create");
  const peerCeiling = yield* peerRuntimeCeiling("thread_create", invocation);
  // A coordinating thread lends its project and runtime mode; a caller with
  // no thread has to name the project and gets the defaults.
  const callerId = McpInvocationContext.callerThreadId(invocation);
  const caller = callerId === null ? null : yield* readShell("thread_create", callerId);
  const projectId = input.projectId ?? caller?.projectId;
  if (projectId === undefined) {
    return yield* toolError(
      "thread_create",
      null,
      "projectId is required when not called from a thread (see project_list)",
    );
  }
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects
    .getShell(projectId)
    .pipe(Effect.mapError(failWith("thread_create", null)));
  if (Option.isNone(project)) {
    return yield* toolError("thread_create", null, `project ${projectId} not found`);
  }
  // A peer may only use the project root or a worktree one of its threads already records.
  const worktreePath =
    peerCeiling === null || input.worktreePath === undefined
      ? input.worktreePath
      : NodePath.resolve(input.worktreePath);
  if (peerCeiling !== null && worktreePath !== undefined) {
    const known = yield* (yield* ThreadManagement.ThreadManagementService)
      .listProjectThreads({ projectId, includeSubagents: true })
      .pipe(Effect.mapError(failWith("thread_create", null)));
    if (
      worktreePath !== NodePath.resolve(project.value.workspaceRoot) &&
      !known.some(
        (shell) =>
          shell.worktreePath !== null && NodePath.resolve(shell.worktreePath) === worktreePath,
      )
    ) {
      return yield* toolError(
        "thread_create",
        null,
        `agents from other environments can only use project ${projectId}'s root or a worktree one of its threads already uses; ${input.worktreePath} is neither`,
      );
    }
  }
  // An explicit modelSelection wins; otherwise the project's default, so a
  // worker runs on its intended model rather than the coordinator's.
  const modelSelection =
    input.modelSelection ?? project.value.defaultModelSelection ?? caller?.modelSelection;
  if (modelSelection === undefined || modelSelection === null) {
    return yield* toolError(
      "thread_create",
      null,
      `project ${projectId} has no default model; pass modelSelection or set a default in the project settings`,
    );
  }
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const commandId = yield* newCommandId("create");
  const messageId =
    peerCeiling === null
      ? MessageId.make(NodeCrypto.randomUUID())
      : PeerGate.makePeerMessageId(NodeCrypto.randomUUID());
  const title = input.title ?? deriveThreadTitle(input.text);
  const { senderThreadId, ...origin } = provenance(invocation);
  const result = yield* launches
    .launch({
      commandId,
      projectId,
      title,
      // Without an explicit title the server replaces the first-line seed
      // with a generated one, as it does for threads started in the UI.
      ...(input.title === undefined ? { generateTitle: true } : {}),
      modelSelection,
      runtimeMode:
        peerCeiling === null
          ? (input.runtimeMode ?? caller?.runtimeMode ?? DEFAULT_RUNTIME_MODE)
          : lowerRuntimeMode(input.runtimeMode ?? peerCeiling, peerCeiling),
      interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      workspaceStrategy:
        worktreePath === undefined
          ? { type: "root", ...(input.branch === undefined ? {} : { branch: input.branch }) }
          : {
              type: "existing_worktree",
              worktreePath,
              ...(input.branch === undefined ? {} : { branch: input.branch }),
            },
      initialMessage: {
        messageId,
        ...(senderThreadId === undefined ? {} : { senderThreadId }),
        text: input.text,
        attachments: [],
      },
      ...origin,
    })
    .pipe(Effect.mapError(failWith("thread_create", null)));
  const run = result.projection.runs.find((candidate) => candidate.userMessageId === messageId);
  return {
    threadId: result.threadId,
    title: result.projection.thread.title,
    messageId,
    runId: run?.id ?? null,
  };
});

const threadUpdate = Effect.fn("ThreadsToolkit.thread_update")(function* (
  input: ThreadsUpdateInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_update");
  const { threadId } = input;
  const wantsMetadata =
    input.title !== undefined ||
    input.regenerateTitle !== undefined ||
    input.branch !== undefined ||
    input.worktreePath !== undefined;
  if (
    !wantsMetadata &&
    input.modelSelection === undefined &&
    input.runtimeMode === undefined &&
    input.interactionMode === undefined &&
    input.settled === undefined &&
    input.archived === undefined &&
    input.pinned === undefined &&
    input.snoozedUntil === undefined
  ) {
    return yield* toolError(
      "thread_update",
      threadId,
      "pass at least one of title, regenerateTitle, modelSelection, branch, worktreePath, runtimeMode, interactionMode, settled, archived, pinned, snoozedUntil",
    );
  }
  if (input.title !== undefined && input.regenerateTitle === true) {
    return yield* toolError(
      "thread_update",
      threadId,
      "pass either title or regenerateTitle, not both",
    );
  }
  yield* readShell("thread_update", threadId);
  // Each field is its own v2 command; the decider enforces lifecycle rules
  // (e.g. only an archived thread can be unarchived), so a bad combination
  // fails on the command that breaks it. The reported sequence is the last.
  const commands: Array<(commandId: CommandId) => OrchestrationV2ServerCommand> = [];
  if (wantsMetadata) {
    commands.push((commandId) => ({
      type: "thread.metadata.update",
      commandId,
      threadId,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.regenerateTitle === undefined ? {} : { regenerateTitle: input.regenerateTitle }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
    }));
  }
  const { modelSelection, runtimeMode, interactionMode, settled, archived, pinned } = input;
  if (modelSelection !== undefined) {
    commands.push((commandId) => ({
      type: "thread.model-selection.set",
      commandId,
      threadId,
      modelSelection,
    }));
  }
  if (interactionMode !== undefined) {
    commands.push((commandId) => ({
      type: "thread.interaction-mode.set",
      commandId,
      threadId,
      interactionMode,
    }));
  }
  if (runtimeMode !== undefined) {
    commands.push((commandId) => ({
      type: "thread.runtime-mode.set",
      commandId,
      threadId,
      runtimeMode,
    }));
  }
  if (settled !== undefined) {
    commands.push((commandId) =>
      settled
        ? { type: "thread.settle", commandId, threadId }
        : { type: "thread.unsettle", commandId, threadId, reason: "user" },
    );
  }
  if (archived !== undefined) {
    commands.push((commandId) => ({
      type: archived ? "thread.archive" : "thread.unarchive",
      commandId,
      threadId,
    }));
  }
  if (pinned !== undefined) {
    commands.push((commandId) => ({
      type: pinned ? "thread.pin" : "thread.unpin",
      commandId,
      threadId,
    }));
  }
  const snoozedUntil = input.snoozedUntil;
  if (snoozedUntil !== undefined) {
    commands.push((commandId) =>
      snoozedUntil === null
        ? { type: "thread.unsnooze", commandId, threadId, reason: "user" }
        : { type: "thread.snooze", commandId, threadId, snoozedUntil },
    );
  }
  let sequence = 0;
  for (const makeCommand of commands) {
    ({ sequence } = yield* dispatch(
      "thread_update",
      threadId,
      makeCommand(yield* newCommandId("update")),
    ));
  }
  return { threadId, sequence };
});

const threadRespond = Effect.fn("ThreadsToolkit.thread_respond")(function* (
  input: ThreadsRespondInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_respond");
  if (input.decision !== undefined && input.answers !== undefined) {
    return yield* toolError(
      "thread_respond",
      input.threadId,
      "pass either decision (approval) or answers (question), not both",
    );
  }
  if (input.decision === undefined && input.answers === undefined) {
    return yield* toolError(
      "thread_respond",
      input.threadId,
      "pass decision (approval) or answers (question)",
    );
  }
  const { status } = yield* readStatus("thread_respond", input.threadId);
  // When the thread has exactly one open request of the kind, callers need
  // not carry its id around: that is the one being answered.
  const wanted = input.decision !== undefined ? "approval" : "question";
  const candidates = status.pendingRequests.filter(
    (request): request is Extract<ThreadsPendingRequest, { requestId: unknown }> =>
      request.kind !== "handback" && request.kind === wanted,
  );
  const request =
    input.requestId !== undefined
      ? candidates.find((candidate) => candidate.requestId === input.requestId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  if (request === undefined) {
    return yield* toolError(
      "thread_respond",
      input.threadId,
      candidates.length === 0 &&
        status.pendingRequests.some((candidate) => candidate.kind === "handback")
        ? "Phi's awaiting-human hand-back is passive; use thread_forward to send the next message, not thread_respond"
        : input.requestId !== undefined
          ? `no pending ${wanted} ${input.requestId} on this thread`
          : candidates.length === 0
            ? `the thread has no pending ${wanted}`
            : `the thread has ${candidates.length} pending ${wanted}s; pass requestId (${candidates.map((candidate) => candidate.requestId).join(", ")})`,
    );
  }
  const { sequence } = yield* dispatch("thread_respond", input.threadId, {
    type: "runtime-request.respond",
    commandId: yield* newCommandId("respond"),
    threadId: input.threadId,
    requestId: request.requestId,
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(input.answers === undefined
      ? {}
      : { answers: threadsNormalizeAnswers(input.answers, request) }),
  });
  return { threadId: input.threadId, sequence };
});

const threadInterrupt = Effect.fn("ThreadsToolkit.thread_interrupt")(function* (
  input: ThreadsInterruptInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_interrupt");
  const shell = yield* readShell("thread_interrupt", input.threadId);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const result = yield* threads
    .interruptThread({
      projectId: shell.projectId,
      commandId: yield* newCommandId("interrupt"),
      threadId: input.threadId,
      ...(input.turnId === undefined ? {} : { runId: input.turnId }),
    })
    .pipe(Effect.mapError(failWith("thread_interrupt", input.threadId)));
  return {
    threadId: input.threadId,
    sequence: result.type === "interrupt_requested" ? result.dispatch.sequence : 0,
  };
});

/** Detach every provider session, as the client's stop-session action does. */
const threadStop = Effect.fn("ThreadsToolkit.thread_stop")(function* (
  input: ThreadsThreadTargetInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_stop");
  const shell = yield* readShell("thread_stop", input.threadId);
  const { providerSessions } = yield* readRecords("thread_stop", shell, ["providerSessions"]);
  const commandId = yield* newCommandId("stop");
  let sequence = 0;
  for (const session of providerSessions) {
    ({ sequence } = yield* dispatch("thread_stop", input.threadId, {
      type: "provider-session.detach",
      commandId: CommandId.make(`${commandId}:detach:${session.id}`),
      threadId: input.threadId,
      providerSessionId: session.id,
      reason: "client-requested",
    }));
  }
  return { threadId: input.threadId, sequence };
});

const threadDelete = Effect.fn("ThreadsToolkit.thread_delete")(function* (
  input: ThreadsDeleteThreadInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_delete");
  yield* requireConfirmed("thread_delete", input.threadId, input.confirm);
  return yield* threadCommand("thread_delete", input.threadId, (commandId) => ({
    type: "thread.delete",
    commandId,
    threadId: input.threadId,
  }));
});

const threadPin = Effect.fn("ThreadsToolkit.thread_pin")(function* (
  input: ThreadsPinInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_pin");
  return yield* threadCommand("thread_pin", input.threadId, (commandId) => ({
    type: "thread.pin",
    commandId,
    threadId: input.threadId,
    ...(input.orderKey === undefined ? {} : { orderKey: input.orderKey }),
  }));
});

const threadUnpin = Effect.fn("ThreadsToolkit.thread_unpin")(function* (
  input: ThreadsThreadTargetInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_unpin");
  return yield* threadCommand("thread_unpin", input.threadId, (commandId) => ({
    type: "thread.unpin",
    commandId,
    threadId: input.threadId,
  }));
});

const threadPinReorder = Effect.fn("ThreadsToolkit.thread_pin_reorder")(function* (
  input: ThreadsPinReorderInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_pin_reorder");
  return yield* threadCommand("thread_pin_reorder", input.threadId, (commandId) => ({
    type: "thread.pin.reorder",
    commandId,
    threadId: input.threadId,
    orderKey: input.orderKey,
  }));
});

const threadSnooze = Effect.fn("ThreadsToolkit.thread_snooze")(function* (
  input: ThreadsSnoozeInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_snooze");
  return yield* threadCommand("thread_snooze", input.threadId, (commandId) => ({
    type: "thread.snooze",
    commandId,
    threadId: input.threadId,
    snoozedUntil: input.snoozedUntil,
  }));
});

const threadUnsnooze = Effect.fn("ThreadsToolkit.thread_unsnooze")(function* (
  input: ThreadsThreadTargetInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_unsnooze");
  return yield* threadCommand("thread_unsnooze", input.threadId, (commandId) => ({
    type: "thread.unsnooze",
    commandId,
    threadId: input.threadId,
    reason: "user",
  }));
});

/**
 * Roll back to the ready checkpoint of run ordinal `turnCount` (0 is the
 * thread's starting state), the same lookup the client's revert uses.
 */
const threadRevert = Effect.fn("ThreadsToolkit.thread_revert")(function* (
  input: ThreadsRevertInput,
): Effect.fn.Return<ThreadsMutationResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_revert");
  yield* requireConfirmed("thread_revert", input.threadId, input.confirm);
  const shell = yield* readShell("thread_revert", input.threadId);
  const { checkpoints } = yield* readRecords("thread_revert", shell, ["checkpoints"]);
  const checkpoint = checkpoints.findLast((candidate) =>
    input.turnCount === 0
      ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null
      : candidate.appRunOrdinal === input.turnCount,
  );
  if (checkpoint === undefined || checkpoint.status !== "ready") {
    return yield* toolError(
      "thread_revert",
      input.threadId,
      `no ready checkpoint for turn ${input.turnCount}`,
    );
  }
  const { sequence } = yield* dispatch("thread_revert", input.threadId, {
    type: "checkpoint.rollback",
    commandId: yield* newCommandId("revert"),
    threadId: input.threadId,
    scopeId: checkpoint.scopeId,
    checkpointId: checkpoint.id,
  });
  return { threadId: input.threadId, sequence };
});

// Listening.

const threadListen = Effect.fn("ThreadsToolkit.thread_listen")(function* (
  input: ThreadsListenInput,
): Effect.fn.Return<ThreadsListenResult, ThreadsToolError, Deps> {
  yield* requireCapability("thread_listen");
  const threads = yield* ThreadManagement.ThreadManagementService;
  const timeoutMs = Math.min(input.timeoutMs ?? THREADS_LISTEN_MAX_MS, THREADS_LISTEN_MAX_MS);
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = startedAt + timeoutMs;
  yield* readShell("thread_listen", input.threadId);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Subscribe before the first read so an event that lands while the
      // shell is read is buffered rather than lost. The shell projection is
      // written before its event is published, so a re-read after an event
      // already sees it.
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      yield* Effect.forkScoped(
        threads.streamDomainEvents.pipe(
          Stream.filter((event) => event.threadId === input.threadId),
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.ignore,
        ),
        { startImmediately: true },
      );

      while (true) {
        const { status } = yield* readStatus("thread_listen", input.threadId);
        const milestone = threadsMilestone(status.state);
        const now = yield* Clock.currentTimeMillis;
        if (milestone !== null) {
          return {
            threadId: input.threadId,
            milestone,
            summary: threadsListenSummary(milestone, status),
            status,
            waitedMs: now - startedAt,
          };
        }
        const remaining = deadline - now;
        if (remaining <= 0) {
          return {
            threadId: input.threadId,
            milestone: "timeout" as const,
            summary: threadsListenSummary("timeout", status),
            status,
            waitedMs: now - startedAt,
          };
        }
        yield* Queue.take(events).pipe(
          Effect.timeoutOption(Math.min(remaining, LISTEN_SAFETY_POLL_MS)),
        );
        // Coalesce a burst (a streaming run emits many events) into one re-read.
        yield* Queue.clear(events);
      }
    }),
  );
});

// Linked environments.

const environmentList = Effect.fn("ThreadsToolkit.environment_list")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ThreadsEnvironmentListResult, ThreadsToolError, Deps> {
  yield* requireCapability("environment_list");
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  const peers = yield* PeerEnvironments.PeerEnvironments;
  const listed = yield* peers.list.pipe(Effect.mapError(failWith("environment_list", null)));
  // A linked environment's session cannot reach this environment's links, so it never sees them.
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const isPeerSession = invocation.environmentSession?.peer === true;
  return {
    local: { environmentId: descriptor.environmentId, label: descriptor.label },
    linkingEnabled: listed.enabled,
    peers: (isPeerSession ? [] : listed.links).map((link) => ({
      environmentId: link.environmentId,
      label: link.label,
      linkedAt: link.linkedAt,
      expiresAt: link.expiresAt,
      ...(link.lastError === null ? {} : { lastError: link.lastError }),
    })),
  };
});

/**
 * A forwarded `thread_create` runs no higher than the caller could here: its thread's mode,
 * its OAuth grant, or full access for a `t3 agent token` session (which can already start a
 * full-access thread locally).
 */
const capForwardedRuntimeMode = Effect.fn("ThreadsToolkit.capForwardedRuntimeMode")(function* (
  input: ThreadsCreateThreadInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const callerId = McpInvocationContext.callerThreadId(invocation);
  const ceiling =
    callerId !== null
      ? (yield* readShell("thread_create", callerId)).runtimeMode
      : invocation.client !== undefined
        ? McpInvocationContext.clientModeCeiling(invocation.client).runtimeMode
        : "full-access";
  return {
    ...input,
    runtimeMode: lowerRuntimeMode(input.runtimeMode ?? ceiling, ceiling),
  } satisfies ThreadsCreateThreadInput;
});

const forwardableHandlers = {
  project_list: forwardable(
    {
      tool: "project_list",
      parameters: ProjectListTool.parametersSchema,
      success: ProjectListTool.successSchema,
    },
    projectList,
  ),
  thread_list: forwardable(
    {
      tool: "thread_list",
      parameters: ThreadListTool.parametersSchema,
      success: ThreadListTool.successSchema,
    },
    threadList,
  ),
  thread_search: forwardable(
    {
      tool: "thread_search",
      parameters: ThreadSearchTool.parametersSchema,
      success: ThreadSearchTool.successSchema,
    },
    threadSearch,
  ),
  thread_status: forwardable(
    {
      tool: "thread_status",
      parameters: ThreadStatusTool.parametersSchema,
      success: ThreadStatusTool.successSchema,
    },
    threadStatus,
  ),
  thread_detail: forwardable(
    {
      tool: "thread_detail",
      parameters: ThreadDetailTool.parametersSchema,
      success: ThreadDetailTool.successSchema,
    },
    threadDetail,
  ),
  thread_transcript: forwardable(
    {
      tool: "thread_transcript",
      parameters: ThreadTranscriptTool.parametersSchema,
      success: ThreadTranscriptTool.successSchema,
    },
    threadTranscript,
  ),
  thread_summaries: forwardable(
    {
      tool: "thread_summaries",
      parameters: ThreadSummariesTool.parametersSchema,
      success: ThreadSummariesTool.successSchema,
    },
    threadSummaries,
  ),
  thread_listen: forwardable(
    {
      tool: "thread_listen",
      parameters: ThreadListenTool.parametersSchema,
      success: ThreadListenTool.successSchema,
      timeoutMs: (input) =>
        Math.min(input.timeoutMs ?? THREADS_LISTEN_MAX_MS, THREADS_LISTEN_MAX_MS) +
        PEER_LISTEN_GRACE_MS,
    },
    threadListen,
  ),
  thread_forward: forwardable(
    {
      tool: "thread_forward",
      parameters: ThreadForwardTool.parametersSchema,
      success: ThreadForwardTool.successSchema,
    },
    threadForward,
  ),
  thread_create: forwardable(
    {
      tool: "thread_create",
      parameters: ThreadCreateTool.parametersSchema,
      success: ThreadCreateTool.successSchema,
      prepare: capForwardedRuntimeMode,
    },
    threadCreate,
  ),
};

export const threadsHandlers = {
  project_list: forwardableHandlers.project_list,
  project_create: projectCreate,
  project_update: projectUpdate,
  project_delete: projectDelete,
  thread_list: forwardableHandlers.thread_list,
  thread_search: forwardableHandlers.thread_search,
  thread_status: forwardableHandlers.thread_status,
  thread_detail: forwardableHandlers.thread_detail,
  thread_transcript: forwardableHandlers.thread_transcript,
  thread_summaries: forwardableHandlers.thread_summaries,
  thread_diff: threadDiff,
  thread_forward: forwardableHandlers.thread_forward,
  thread_create: forwardableHandlers.thread_create,
  thread_update: threadUpdate,
  thread_respond: threadRespond,
  thread_interrupt: threadInterrupt,
  thread_stop: threadStop,
  thread_delete: threadDelete,
  thread_pin: threadPin,
  thread_unpin: threadUnpin,
  thread_pin_reorder: threadPinReorder,
  thread_snooze: threadSnooze,
  thread_unsnooze: threadUnsnooze,
  thread_revert: threadRevert,
  thread_listen: forwardableHandlers.thread_listen,
  environment_list: environmentList,
} satisfies Parameters<typeof ThreadsToolkit.toLayer>[0];

// exowatt: declared through McpToolAccess so `/mcp` registers them with an access rule.
const refuse = (tool: ThreadsToolName) => () =>
  toolError(
    tool,
    null,
    `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability.`,
  );

export const ThreadsToolkitHandlersLive = McpToolAccess.toLayer(ThreadsToolkit, {
  project_list: McpToolAccess.usesCommandCenter(
    refuse("project_list"),
    forwardableHandlers.project_list,
  ),
  project_create: McpToolAccess.usesCommandCenter(refuse("project_create"), projectCreate),
  project_update: McpToolAccess.usesCommandCenter(refuse("project_update"), projectUpdate),
  project_delete: McpToolAccess.usesCommandCenter(refuse("project_delete"), projectDelete),
  thread_list: McpToolAccess.usesCommandCenter(
    refuse("thread_list"),
    forwardableHandlers.thread_list,
  ),
  thread_search: McpToolAccess.usesCommandCenter(
    refuse("thread_search"),
    forwardableHandlers.thread_search,
  ),
  thread_status: McpToolAccess.usesCommandCenter(
    refuse("thread_status"),
    forwardableHandlers.thread_status,
  ),
  thread_detail: McpToolAccess.usesCommandCenter(
    refuse("thread_detail"),
    forwardableHandlers.thread_detail,
  ),
  thread_transcript: McpToolAccess.usesCommandCenter(
    refuse("thread_transcript"),
    forwardableHandlers.thread_transcript,
  ),
  thread_summaries: McpToolAccess.usesCommandCenter(
    refuse("thread_summaries"),
    forwardableHandlers.thread_summaries,
  ),
  thread_diff: McpToolAccess.usesCommandCenter(refuse("thread_diff"), threadDiff),
  thread_forward: McpToolAccess.usesCommandCenter(
    refuse("thread_forward"),
    forwardableHandlers.thread_forward,
  ),
  thread_create: McpToolAccess.usesCommandCenter(
    refuse("thread_create"),
    forwardableHandlers.thread_create,
  ),
  thread_update: McpToolAccess.usesCommandCenter(refuse("thread_update"), threadUpdate),
  thread_respond: McpToolAccess.usesCommandCenter(refuse("thread_respond"), threadRespond),
  thread_interrupt: McpToolAccess.usesCommandCenter(refuse("thread_interrupt"), threadInterrupt),
  thread_stop: McpToolAccess.usesCommandCenter(refuse("thread_stop"), threadStop),
  thread_delete: McpToolAccess.usesCommandCenter(refuse("thread_delete"), threadDelete),
  thread_pin: McpToolAccess.usesCommandCenter(refuse("thread_pin"), threadPin),
  thread_unpin: McpToolAccess.usesCommandCenter(refuse("thread_unpin"), threadUnpin),
  thread_pin_reorder: McpToolAccess.usesCommandCenter(
    refuse("thread_pin_reorder"),
    threadPinReorder,
  ),
  thread_snooze: McpToolAccess.usesCommandCenter(refuse("thread_snooze"), threadSnooze),
  thread_unsnooze: McpToolAccess.usesCommandCenter(refuse("thread_unsnooze"), threadUnsnooze),
  thread_revert: McpToolAccess.usesCommandCenter(refuse("thread_revert"), threadRevert),
  thread_listen: McpToolAccess.usesCommandCenter(
    refuse("thread_listen"),
    forwardableHandlers.thread_listen,
  ),
  environment_list: McpToolAccess.usesCommandCenter(refuse("environment_list"), environmentList),
} satisfies McpToolAccess.Handlers<typeof ThreadsToolkit.tools>);
