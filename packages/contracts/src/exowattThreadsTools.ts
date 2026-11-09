// Exowatt distro: MCP tool contracts (`thread_*`, `project_*`) agents use to coordinate through
// P3. Every mutation maps onto one orchestration-v2 command or service call and every read
// projects the thread shell the UI renders. Tool names and inputs are a wire contract.
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ShellThreadStatus,
} from "./orchestrationV2.ts";
import { ProjectFaviconPath, ProjectScript } from "./project.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./providerPolicy.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { OrchestrationThreadSearchMatch } from "./threadSearch.ts";

/** MCP capability a credential must carry to call the Threads tools. */
export const EXOWATT_THREADS_MCP_CAPABILITY = "command-center";

/**
 * The tools that take `environmentId` and are forwarded to a linked P3 environment when it
 * names one. Everything else (mutations beyond forward/create, deletes, settings) stays local.
 */
export const EXOWATT_THREADS_FORWARDABLE_TOOLS = [
  "project_list",
  "thread_list",
  "thread_search",
  "thread_status",
  "thread_detail",
  "thread_transcript",
  "thread_summaries",
  "thread_listen",
  "thread_forward",
  "thread_create",
] as const;
export type ThreadsForwardableToolName = (typeof EXOWATT_THREADS_FORWARDABLE_TOOLS)[number];

/** Optional target environment on the forwardable tools; omitted means this environment. */
const threadsEnvironmentIdField = {
  environmentId: Schema.optional(
    EnvironmentId.annotate({
      description:
        "Optional. A linked environment from `environment_list`; omit for this environment.",
    }),
  ),
} as const;

/**
 * Where a thread stands for an agent: `running` (a run in flight), `needs-you` (an approval,
 * question or plan waits on a human; agents never answer it), `failed`, `finished` (completed,
 * nothing pending), `idle` (never ran or interrupted) or `archived`.
 */
export const ThreadsThreadState = Schema.Literals([
  "running",
  "needs-you",
  "failed",
  "finished",
  "idle",
  "archived",
]);
export type ThreadsThreadState = typeof ThreadsThreadState.Type;

/** The three states a listener returns on; `timeout` means "still going". */
export const ThreadsMilestone = Schema.Literals(["finished", "needs-you", "failed", "timeout"]);
export type ThreadsMilestone = typeof ThreadsMilestone.Type;

/**
 * One thing a thread is waiting on the user for, in the words the thread
 * used. Approvals and questions are respondable with `thread_respond`;
 * a Phi hand-back is informational and starts its next turn via `thread_forward`.
 */
export const ThreadsPendingRequest = Schema.Union([
  Schema.Struct({
    requestId: RuntimeRequestId,
    kind: Schema.Literals(["approval", "question"]),
    /** What the thread asked: the approval detail or the question text(s). */
    prompt: TrimmedNonEmptyString,
    /** Choices offered, when any; approvals accept `decision`, questions `answers`. */
    options: Schema.Array(TrimmedNonEmptyString),
    /** Question ids to key `answers` by; empty for approvals. */
    questionIds: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("handback"),
    prompt: TrimmedNonEmptyString,
    options: Schema.Array(TrimmedNonEmptyString),
    questionIds: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type ThreadsPendingRequest = typeof ThreadsPendingRequest.Type;

/** The thread's latest run, as the sidebar row reads it. */
export const ThreadsLatestRun = Schema.Struct({
  runId: RunId,
  status: OrchestrationV2ShellThreadStatus,
  requestedAt: Schema.NullOr(IsoDateTime),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadsLatestRun = typeof ThreadsLatestRun.Type;

const threadsThreadSummaryFields = {
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  state: ThreadsThreadState,
  latestRun: Schema.NullOr(ThreadsLatestRun),
  /** The last provider error the thread reported, when it has one. */
  lastError: Schema.NullOr(Schema.String),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  /** Who started the thread and from which surface (`mcp` for agents). */
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  /** true when the thread sits on the sidebar's settled shelf. */
  settled: Schema.Boolean,
  /** When the thread was put on the settled shelf; null when it is not. */
  settledAt: Schema.NullOr(IsoDateTime),
  /** The user's explicit settle/unsettle, when they made one; null otherwise. */
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  updatedAt: IsoDateTime,
} as const;

/** One row of `thread_list`: the status without the (per-thread) pending requests. */
export const ThreadsThreadSummary = Schema.Struct(threadsThreadSummaryFields);
export type ThreadsThreadSummary = typeof ThreadsThreadSummary.Type;

export const ThreadsThreadStatus = Schema.Struct({
  ...threadsThreadSummaryFields,
  pendingRequests: Schema.Array(ThreadsPendingRequest),
}).annotate({
  description:
    "A compact view of one thread: where it stands and whether it is waiting on the user.",
});
export type ThreadsThreadStatus = typeof ThreadsThreadStatus.Type;

/**
 * Everything the thread header, sidebar row and composer show about one
 * thread, on top of `thread_status`. Read-only companion to `thread_update`.
 */
export const ThreadsThreadDetail = Schema.Struct({
  ...threadsThreadSummaryFields,
  pendingRequests: Schema.Array(ThreadsPendingRequest),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** Git branch the thread works on, when it was given one. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /** Worktree the thread runs in; null means the project root. */
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  /** true when the thread sits in the sidebar's pinned block. */
  pinned: Schema.Boolean,
  /** Fractional index the pinned block sorts by; null when never reordered. */
  pinOrderKey: Schema.NullOr(TrimmedNonEmptyString),
  /** Wake time while the thread is snoozed; null when it is not. */
  snoozedUntil: Schema.NullOr(IsoDateTime),
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
}).annotate({
  description: "Every field the P3 thread header and sidebar row render for one thread.",
});
export type ThreadsThreadDetail = typeof ThreadsThreadDetail.Type;

export const ThreadsProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  updatedAt: IsoDateTime,
});
export type ThreadsProject = typeof ThreadsProject.Type;

export const ThreadsProjectListResult = Schema.Struct({
  projects: Schema.Array(ThreadsProject),
});
export type ThreadsProjectListResult = typeof ThreadsProjectListResult.Type;

const ThreadListTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);

export const ThreadsProjectListInput = Schema.Struct({ ...threadsEnvironmentIdField });
export type ThreadsProjectListInput = typeof ThreadsProjectListInput.Type;

export const ThreadsThreadListInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  projectId: Schema.optional(
    ProjectId.annotate({ description: "Only threads in this project. Defaults to every project." }),
  ),
  state: Schema.optional(
    Schema.Array(ThreadsThreadState).annotate({
      description:
        'Only threads in these states, e.g. ["needs-you"]. Defaults to every active state; include `archived` to see archived threads.',
    }),
  ),
  limit: Schema.optional(
    PositiveInt.annotate({
      description: "Most recently updated threads to return. Defaults to 50.",
    }),
  ),
  updatedAfter: Schema.optional(
    ThreadListTimestamp.annotate({
      description:
        "Only return threads whose updatedAt, latest run requestedAt, or latest run completedAt is strictly after this ISO timestamp.",
    }),
  ),
  includeSettled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Include threads the user put on the settled shelf (`settled: true`). Defaults to true. Pass false to drop them before `limit`; `total` and `hasMore` then count only the threads that were kept.",
    }),
  ),
  includeSubagents: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Include the child threads providers spawn for their own subagents. Defaults to false.",
    }),
  ),
});
export type ThreadsThreadListInput = typeof ThreadsThreadListInput.Type;

export const ThreadsThreadListResult = Schema.Struct({
  threads: Schema.Array(ThreadsThreadSummary),
  /** Threads that matched before `limit` was applied. */
  total: NonNegativeInt,
  /** True when `total` is larger than the returned page. */
  hasMore: Schema.Boolean,
  /** The timestamp supplied by the caller, or null when no filter was used. */
  updatedAfter: Schema.NullOr(IsoDateTime),
  /**
   * Read boundary. Use this as the next `updatedAfter` only when `hasMore` is
   * false; otherwise repeat the same `updatedAfter` with a larger `limit`.
   */
  serverTime: IsoDateTime,
});
export type ThreadsThreadListResult = typeof ThreadsThreadListResult.Type;

export const ThreadsTranscriptInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  threadId: ThreadId.annotate({ description: "The thread to read." }),
  turnLimit: Schema.optional(
    PositiveInt.annotate({
      description: "Turns per page, newest first. Defaults to 10.",
    }),
  ),
  beforeCursor: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Opaque `page.beforeCursor` from a previous page, to read older turns.",
    }),
  ),
  maxChars: Schema.optional(
    PositiveInt.annotate({
      description: "Truncate each message to this many characters. Defaults to 4000.",
    }),
  ),
});
export type ThreadsTranscriptInput = typeof ThreadsTranscriptInput.Type;

export const ThreadsTranscriptMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  truncated: Schema.Boolean,
  runId: Schema.NullOr(RunId),
  streaming: Schema.Boolean,
  createdBy: OrchestrationV2Actor,
  /** The thread whose agent sent this message, when another thread did. */
  senderThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type ThreadsTranscriptMessage = typeof ThreadsTranscriptMessage.Type;

export const ThreadsTranscriptResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  state: ThreadsThreadState,
  /** Oldest first within the page. */
  messages: Schema.Array(ThreadsTranscriptMessage),
  page: Schema.Struct({
    /** Pass back as `beforeCursor` for the next older page; null when fully read. */
    beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
    hasMore: Schema.Boolean,
  }),
});
export type ThreadsTranscriptResult = typeof ThreadsTranscriptResult.Type;

const threadsSummariesOptions = {
  limit: Schema.optional(
    PositiveInt.annotate({
      description: "Most recent entries to return per section. Defaults to 20.",
    }),
  ),
  maxChars: Schema.optional(
    PositiveInt.annotate({
      description:
        "Truncate each summary and the latest assistant message to this many characters. Defaults to 4000.",
    }),
  ),
} as const;

export const ThreadsSummariesInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  threadId: Schema.optional(ThreadId.annotate({ description: "The thread to summarize." })),
  threadIds: Schema.optional(
    Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(20)).annotate({
      description:
        "Up to 20 threads to summarize in request order. If any thread is missing or archived, the entire batch fails and no summaries are returned.",
    }),
  ),
  ...threadsSummariesOptions,
})
  .check(
    Schema.makeFilter(
      (input) => (input.threadId === undefined) !== (input.threadIds === undefined),
    ),
  )
  .annotate({
    description:
      "Pass exactly one of threadId for the existing single-thread response or threadIds for a batch response. A batch is atomic: any missing or archived thread fails the whole request.",
  });
export type ThreadsSummariesInput = typeof ThreadsSummariesInput.Type;

/** A subagent task that finished, with the result it reported. */
export const ThreadsTaskCompletion = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  title: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  /** The child thread the subagent ran in, when it has one. */
  childThreadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  createdAt: IsoDateTime,
});
export type ThreadsTaskCompletion = typeof ThreadsTaskCompletion.Type;

export const ThreadsSummariesResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  state: ThreadsThreadState,
  latestRun: Schema.NullOr(ThreadsLatestRun),
  /** The assistant's final message of the latest run, when it has one. */
  latestAssistantText: Schema.NullOr(Schema.String),
  latestAssistantTruncated: Schema.Boolean,
  /** Newest first. */
  taskCompletions: Schema.Array(ThreadsTaskCompletion),
});
export type ThreadsSummariesResult = typeof ThreadsSummariesResult.Type;

export const ThreadsSummariesBatchResult = Schema.Struct({
  /** In the same order as the requested `threadIds`. */
  summaries: Schema.Array(ThreadsSummariesResult),
});
export type ThreadsSummariesBatchResult = typeof ThreadsSummariesBatchResult.Type;

export const ThreadsSummariesToolResult = Schema.Union([
  ThreadsSummariesResult,
  ThreadsSummariesBatchResult,
]);
export type ThreadsSummariesToolResult = typeof ThreadsSummariesToolResult.Type;

export const ThreadsThreadTargetInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to act on." }),
});
export type ThreadsThreadTargetInput = typeof ThreadsThreadTargetInput.Type;

/** `thread_status` / `thread_detail`: a thread target that may live on a linked environment. */
export const ThreadsThreadReadInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  threadId: ThreadId.annotate({ description: "The thread to read." }),
});
export type ThreadsThreadReadInput = typeof ThreadsThreadReadInput.Type;

export const EXOWATT_THREAD_TOOL_DESCRIPTIONS = {
  threadForward:
    "Send a message to another thread as a new user turn; it queues behind a running turn. The receiving thread has none of your conversation or context: write a self-contained brief with the goal and definition of done, relevant facts and decisions, repo/branch/worktree, constraints, and how to report back. When relaying the user's own words or decision, keep them verbatim and say so. When called from a P3 thread, that thread is recorded as the sender.",
  threadCreate:
    "Start a new thread with a first user turn. The receiving thread has none of your conversation or context: write a self-contained brief with the goal and definition of done, relevant facts and decisions, repo/branch/worktree, constraints, and how to report back. When relaying the user's own words or decision, keep them verbatim and say so. When called from a P3 thread, that thread is recorded as the sender.",
  threadForwardText:
    "Self-contained brief for the receiving thread: include the goal and definition of done, relevant facts and decisions, repo/branch/worktree, constraints, and how to report back. Keep the user's own words or decision verbatim when relaying them, and say so.",
  environmentList:
    "List this P3 environment and the user's other P3 environments linked to it. Pass a linked `environmentId` to project_list, thread_list, thread_search, thread_status, thread_detail, thread_transcript, thread_summaries, thread_listen, thread_forward or thread_create to work with that environment's threads; every other tool acts on this environment only. Linking is off by default: the user turns it on in the P3 desktop app under Settings › Sharing & access (Agents reach my other environments), and the desktop links the environments it is connected to. `lastError` says why the last call to a peer failed. Read-only.",
  threadCreateText:
    "Self-contained brief for the new thread: include the goal and definition of done, relevant facts and decisions, repo/branch/worktree, constraints, and how to report back. Keep the user's own words or decision verbatim when relaying them, and say so.",
} as const;

export const ThreadsForwardInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  threadId: ThreadId.annotate({ description: "The thread that should receive the message." }),
  text: TrimmedNonEmptyString.annotate({
    description: EXOWATT_THREAD_TOOL_DESCRIPTIONS.threadForwardText,
  }),
});
export type ThreadsForwardInput = typeof ThreadsForwardInput.Type;

export const ThreadsCreateThreadInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  text: TrimmedNonEmptyString.annotate({
    description: EXOWATT_THREAD_TOOL_DESCRIPTIONS.threadCreateText,
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional short title. Defaults to the first line of the message.",
    }),
  ),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Project to create the thread in. Defaults to the calling thread's project; required when the caller is not a thread (see project_list).",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({
      description:
        "Permission mode for the new thread. Defaults to the calling thread's mode, or the server default when the caller is not a thread. Reached through an SSH-connected environment's reverse link, it defaults to the caller's own mode and is capped at it and at the receiving environment's inbound limit.",
    }),
  ),
  modelSelection: Schema.optional(
    ModelSelection.annotate({
      description:
        "Provider instance and model to run the new thread on, e.g. { instanceId, model }. Overrides the project default; omit to use it.",
    }),
  ),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description:
        '"plan" starts the thread in plan mode, so it proposes a plan before touching anything. Defaults to "default".',
    }),
  ),
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Git branch the new thread should work on. Defaults to none.",
    }),
  ),
  worktreePath: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Absolute path of an existing worktree to run the new thread in. Defaults to the project root. Reached through an SSH-connected environment's reverse link, it must be the project root or a worktree one of the project's threads already uses.",
    }),
  ),
});
export type ThreadsCreateThreadInput = typeof ThreadsCreateThreadInput.Type;

export const ThreadsUpdateInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to change." }),
  title: Schema.optional(TrimmedNonEmptyString.annotate({ description: "New title." })),
  modelSelection: Schema.optional(
    ModelSelection.annotate({
      description:
        "Provider instance and model for the thread's next turns, e.g. { instanceId, model }. Takes effect on the next turn.",
    }),
  ),
  runtimeMode: Schema.optional(
    RuntimeMode.annotate({ description: "Permission mode for the thread's next turns." }),
  ),
  settled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true moves the thread to the settled shelf (done, nothing pending); false brings it back to active.",
    }),
  ),
  archived: Schema.optional(
    Schema.Boolean.annotate({
      description: "true archives the thread; false restores an archived thread.",
    }),
  ),
  interactionMode: Schema.optional(
    ProviderInteractionMode.annotate({
      description:
        'Interaction mode for the thread\'s next turns: "plan" makes it propose a plan first, "default" lets it act.',
    }),
  ),
  regenerateTitle: Schema.optional(
    Schema.Literal(true).annotate({
      description:
        "true asks the server to re-derive the title from the conversation. Cannot be combined with `title`.",
    }),
  ),
  branch: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString).annotate({
      description: "Git branch the thread works on; null clears it.",
    }),
  ),
  worktreePath: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString).annotate({
      description: "Worktree the thread runs in; null clears it back to the project root.",
    }),
  ),
  pinned: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true pins the thread to the top of the sidebar; false unpins it. Use thread_pin_reorder to move a pinned thread.",
    }),
  ),
  snoozedUntil: Schema.optional(
    Schema.NullOr(
      IsoDateTime.annotate({
        description:
          "ISO timestamp to snooze the thread until (it hides from the active list until then); null wakes it now.",
      }),
    ),
  ),
});
export type ThreadsUpdateInput = typeof ThreadsUpdateInput.Type;

export const ThreadsRespondInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread that asked." }),
  requestId: Schema.optional(
    RuntimeRequestId.annotate({
      description:
        "The pending approval or question id, from thread_status.pendingRequests. May be omitted when the thread has exactly one pending request of that kind.",
    }),
  ),
  decision: Schema.optional(
    ProviderApprovalDecision.annotate({
      description: "For approvals: the user's decision, exactly as they gave it.",
    }),
  ),
  answers: Schema.optional(
    ProviderUserInputAnswers.annotate({
      description: "For questions: the user's answers keyed by question id.",
    }),
  ),
});
export type ThreadsRespondInput = typeof ThreadsRespondInput.Type;

export const ThreadsListenInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  threadId: ThreadId.annotate({ description: "The thread to wait on." }),
  timeoutMs: Schema.optional(
    PositiveInt.annotate({
      description:
        "How long to wait before returning `timeout` so the caller can call again. Defaults to the server maximum.",
    }),
  ),
});
export type ThreadsListenInput = typeof ThreadsListenInput.Type;

/**
 * `confirm` on the destructive tools. Spelled as a literal `true` so a model
 * cannot delete anything by passing the id alone, and so the refusal shows up
 * as a schema error naming the field.
 */
const ThreadsConfirmField = Schema.Literal(true).annotate({
  description: "Must be exactly true. This action cannot be undone.",
});

export const ThreadsInterruptInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread whose running turn should stop." }),
  turnId: Schema.optional(
    RunId.annotate({
      description:
        "Only interrupt this run (thread_status.latestRun.runId), so a run that already finished is not mistaken for the current one. Defaults to whatever is running.",
    }),
  ),
});
export type ThreadsInterruptInput = typeof ThreadsInterruptInput.Type;

export const ThreadsDeleteThreadInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to delete, permanently." }),
  confirm: ThreadsConfirmField,
});
export type ThreadsDeleteThreadInput = typeof ThreadsDeleteThreadInput.Type;

export const ThreadsPinInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to pin." }),
  orderKey: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Slot in the pinned order. Pinned threads sort by plain string comparison of these keys. Omit to let the pinned block fall back to creation order.",
    }),
  ),
});
export type ThreadsPinInput = typeof ThreadsPinInput.Type;

export const ThreadsPinReorderInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The pinned thread to move." }),
  orderKey: TrimmedNonEmptyString.annotate({
    description:
      "The thread's new slot: a key that sorts (plain string comparison) between the two threads it should land between. Only this thread's key changes.",
  }),
});
export type ThreadsPinReorderInput = typeof ThreadsPinReorderInput.Type;

export const ThreadsSnoozeInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to snooze." }),
  snoozedUntil: IsoDateTime.annotate({
    description:
      "ISO timestamp to snooze until, e.g. 2026-09-10T09:00:00.000Z. The thread hides from the active list until then.",
  }),
});
export type ThreadsSnoozeInput = typeof ThreadsSnoozeInput.Type;

export const ThreadsSearchInput = Schema.Struct({
  ...threadsEnvironmentIdField,
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)).annotate({
    description: "Text to look for in thread titles, user messages and assistant replies.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
      description: "Matches to return, at most 50. Defaults to the server's own default.",
    }),
  ),
});
export type ThreadsSearchInput = typeof ThreadsSearchInput.Type;

export const ThreadsSearchResult = Schema.Struct({
  /**
   * One row per matching thread, with the snippet that matched. Follow up with
   * `thread_detail` or `thread_transcript` for the thread itself.
   */
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type ThreadsSearchResult = typeof ThreadsSearchResult.Type;

/**
 * Which checkpoint range to diff, exactly one form: `turnCount` alone (that turn), `fromTurnCount`
 * + `toTurnCount` (that range), or `full: true` with `toTurnCount` or `turnCount` (turn 0 to it).
 */
export const ThreadsDiffInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to diff." }),
  turnCount: Schema.optional(
    PositiveInt.annotate({
      description:
        "Diff just this turn: the change between checkpoint turnCount - 1 and checkpoint turnCount. With `full: true`, the end of the range instead.",
    }),
  ),
  fromTurnCount: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Start of an explicit checkpoint range; 0 is the thread's starting state. Pass with toTurnCount, and not with turnCount or full.",
    }),
  ),
  toTurnCount: Schema.optional(
    NonNegativeInt.annotate({ description: "End of the range. Pass with fromTurnCount or full." }),
  ),
  full: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true diffs everything the thread changed, from turn 0 through toTurnCount (or turnCount). Do not pass fromTurnCount with it.",
    }),
  ),
  ignoreWhitespace: Schema.optional(
    Schema.Boolean.annotate({ description: "Ignore whitespace-only changes. Defaults to true." }),
  ),
  maxChars: Schema.optional(
    PositiveInt.annotate({
      description:
        "Truncate the patch to this many characters so one diff cannot swamp your context. Defaults to 20000.",
    }),
  ),
});
export type ThreadsDiffInput = typeof ThreadsDiffInput.Type;

export const ThreadsDiffResult = Schema.Struct({
  threadId: ThreadId,
  /** The range actually diffed, after the input form was resolved. */
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  /** true when this is the thread's whole change set rather than a range. */
  full: Schema.Boolean,
  /** Unified diff. Empty when nothing changed in the range. */
  diff: Schema.String,
  /** true when the patch was cut at `maxChars`; narrow the range to see the rest. */
  truncated: Schema.Boolean,
});
export type ThreadsDiffResult = typeof ThreadsDiffResult.Type;

export const ThreadsRevertInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to roll back." }),
  turnCount: NonNegativeInt.annotate({
    description:
      "Restore the workspace to this turn's checkpoint. 0 is the state the thread started from. Later turns' file changes are discarded.",
  }),
  confirm: ThreadsConfirmField,
});
export type ThreadsRevertInput = typeof ThreadsRevertInput.Type;

export const ThreadsCreateProjectInput = Schema.Struct({
  title: TrimmedNonEmptyString.annotate({
    description: "Project name, as it should read in the sidebar.",
  }),
  workspaceRoot: TrimmedNonEmptyString.annotate({
    description: "Absolute path of the directory the project is rooted at.",
  }),
  createWorkspaceRootIfMissing: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true creates the directory when it does not exist. Defaults to false, which fails instead.",
    }),
  ),
  defaultModelSelection: Schema.optional(
    ModelSelection.annotate({
      description:
        "Model new threads in this project start on, e.g. { instanceId, model }. Without one, thread_create has to be given a modelSelection.",
    }),
  ),
});
export type ThreadsCreateProjectInput = typeof ThreadsCreateProjectInput.Type;

export const ThreadsUpdateProjectInput = Schema.Struct({
  projectId: ProjectId.annotate({ description: "The project to change." }),
  title: Schema.optional(TrimmedNonEmptyString.annotate({ description: "New project name." })),
  workspaceRoot: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Absolute path of the directory the project is rooted at.",
    }),
  ),
  defaultModelSelection: Schema.optional(
    Schema.NullOr(ModelSelection).annotate({
      description: "Default model for new threads; null clears it.",
    }),
  ),
  defaultThreadEnvMode: Schema.optional(
    Schema.NullOr(ThreadEnvMode).annotate({
      description:
        'Where new threads run by default: "local" in the project root, "worktree" in a fresh worktree. null clears the override.',
    }),
  ),
  faviconPath: Schema.optional(
    Schema.NullOr(ProjectFaviconPath).annotate({
      description: "Project-relative path to the icon shown in the sidebar; null clears it.",
    }),
  ),
  scripts: Schema.optional(
    Schema.Array(ProjectScript).annotate({
      description:
        "The project's full script list, replacing what is there. Read the current list from project_list first.",
    }),
  ),
});
export type ThreadsUpdateProjectInput = typeof ThreadsUpdateProjectInput.Type;

export const ThreadsDeleteProjectInput = Schema.Struct({
  projectId: ProjectId.annotate({ description: "The project to delete, permanently." }),
  force: Schema.optional(
    Schema.Boolean.annotate({
      description: "true deletes the project even when it still has threads.",
    }),
  ),
  confirm: ThreadsConfirmField,
});
export type ThreadsDeleteProjectInput = typeof ThreadsDeleteProjectInput.Type;

/** Every thread mutation returns the sequence of the last event it produced. */
export const ThreadsMutationResult = Schema.Struct({
  threadId: ThreadId,
  sequence: NonNegativeInt,
});
export type ThreadsMutationResult = typeof ThreadsMutationResult.Type;

/** Project mutations return the project as it now stands. */
export const ThreadsProjectMutationResult = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type ThreadsProjectMutationResult = typeof ThreadsProjectMutationResult.Type;

export const ThreadsCreateProjectResult = ThreadsProjectMutationResult;
export type ThreadsCreateProjectResult = ThreadsProjectMutationResult;

export const ThreadsForwardResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  /** `started` on an idle thread, `queued` behind a running turn. */
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  sequence: NonNegativeInt,
});
export type ThreadsForwardResult = typeof ThreadsForwardResult.Type;

export const ThreadsCreateThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
});
export type ThreadsCreateThreadResult = typeof ThreadsCreateThreadResult.Type;

export const ThreadsListenResult = Schema.Struct({
  threadId: ThreadId,
  milestone: ThreadsMilestone,
  /**
   * One human-readable line, e.g. `finished — "Update README"`. A listener
   * running with thinking off reports this verbatim instead of restating the
   * status record.
   */
  summary: TrimmedNonEmptyString,
  status: ThreadsThreadStatus,
  waitedMs: NonNegativeInt,
});
export type ThreadsListenResult = typeof ThreadsListenResult.Type;

export const ThreadsToolName = Schema.Literals([
  "project_list",
  "project_create",
  "project_update",
  "project_delete",
  "thread_list",
  "thread_search",
  "thread_status",
  "thread_detail",
  "thread_transcript",
  "thread_summaries",
  "thread_diff",
  "thread_forward",
  "thread_create",
  "thread_update",
  "thread_respond",
  "thread_interrupt",
  "thread_stop",
  "thread_delete",
  "thread_pin",
  "thread_unpin",
  "thread_pin_reorder",
  "thread_snooze",
  "thread_unsnooze",
  "thread_revert",
  "thread_listen",
  "environment_list",
]);
export type ThreadsToolName = typeof ThreadsToolName.Type;

export const ThreadsEnvironmentListResult = Schema.Struct({
  local: Schema.Struct({ environmentId: EnvironmentId, label: TrimmedNonEmptyString }),
  /** Server setting `exowattCrossEnvironmentAgentTools`. */
  linkingEnabled: Schema.Boolean,
  peers: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: TrimmedNonEmptyString,
      linkedAt: IsoDateTime,
      expiresAt: IsoDateTime,
      lastError: Schema.optional(Schema.String),
    }),
  ),
});
export type ThreadsEnvironmentListResult = typeof ThreadsEnvironmentListResult.Type;

// The runtime tag predates the Threads rename; clients still match on it.
export class ThreadsToolError extends Schema.TaggedError<ThreadsToolError>()(
  "CommandCenterToolError",
  {
    tool: ThreadsToolName,
    threadId: Schema.NullOr(ThreadId),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.tool} failed${this.threadId ? ` for thread ${this.threadId}` : ""}: ${this.detail}`;
  }
}
