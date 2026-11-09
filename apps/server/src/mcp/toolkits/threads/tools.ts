// Exowatt distro: the thread MCP toolkit, shared by in-app and outside coding agents
// holding a `t3 agent token` session. Nothing here runs a model on the user's behalf.
// Tool names are a wire contract; keep them stable. Tools that destroy work
// (`thread_delete`, `thread_revert`, `project_delete`) take `confirm: true`.
import {
  ThreadsCreateProjectInput,
  ThreadsCreateProjectResult,
  ThreadsCreateThreadInput,
  ThreadsCreateThreadResult,
  EXOWATT_THREAD_TOOL_DESCRIPTIONS,
  ThreadsDeleteProjectInput,
  ThreadsDeleteThreadInput,
  ThreadsDiffInput,
  ThreadsDiffResult,
  ThreadsEnvironmentListResult,
  ThreadsForwardInput,
  ThreadsForwardResult,
  ThreadsInterruptInput,
  ThreadsListenInput,
  ThreadsListenResult,
  ThreadsMutationResult,
  ThreadsPinInput,
  ThreadsPinReorderInput,
  ThreadsProjectListInput,
  ThreadsProjectListResult,
  ThreadsProjectMutationResult,
  ThreadsRespondInput,
  ThreadsRevertInput,
  ThreadsSearchInput,
  ThreadsSearchResult,
  ThreadsSnoozeInput,
  ThreadsSummariesInput,
  ThreadsSummariesToolResult,
  ThreadsThreadDetail,
  ThreadsThreadListInput,
  ThreadsThreadListResult,
  ThreadsThreadReadInput,
  ThreadsThreadStatus,
  ThreadsThreadTargetInput,
  ThreadsToolError,
  ThreadsTranscriptInput,
  ThreadsTranscriptResult,
  ThreadsUpdateInput,
  ThreadsUpdateProjectInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PeerEnvironments from "../../../exowattPeerEnvironments/PeerEnvironments.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  ThreadLaunch.ThreadLaunchService,
  ThreadSearch.ThreadSearch,
  ProjectService.ProjectService,
  CheckpointDiffQuery.CheckpointDiffQuery,
  // exowatt: forwarding to linked environments.
  ServerEnvironment.ServerEnvironment,
  PeerEnvironments.PeerEnvironments,
];

export const ProjectListTool = Tool.make("project_list", {
  description:
    "List the projects on this server with their ids and default models. Use the id for thread_create.projectId. Read-only.",
  parameters: ThreadsProjectListInput,
  success: ThreadsProjectListResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ProjectCreateTool = Tool.make("project_create", {
  description:
    "Add a project rooted at a directory on this server, so threads can be created in it. Give it a default model unless every thread_create will name one.",
  parameters: ThreadsCreateProjectInput,
  success: ThreadsCreateProjectResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create project")
  .annotate(Tool.Destructive, false);

export const ProjectUpdateTool = Tool.make("project_update", {
  description:
    "Change a project's settings, covering everything in the Project Settings dialog: name, workspace root, default model, default thread environment, favicon, and the script list. Pass only the fields to change; `scripts` replaces the whole list, so read it from project_list first.",
  parameters: ThreadsUpdateProjectInput,
  success: ThreadsProjectMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update project settings")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ProjectDeleteTool = Tool.make("project_delete", {
  description:
    "Delete a project. Destructive and permanent: pass `confirm: true`, and `force: true` when it still has threads. Ask the user first.",
  parameters: ThreadsDeleteProjectInput,
  success: ThreadsProjectMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete project")
  .annotate(Tool.Destructive, true);

export const ThreadListTool = Tool.make("thread_list", {
  description:
    'List threads, most recently updated first, with where each stands (running, needs-you, finished, failed, idle, archived). Filter by project and by state; `state: ["needs-you"], includeSettled: false` is what the user must still look at (it drops the threads they already moved to the settled shelf). Every row carries `settled`, `settledAt` and `settledOverride`. Pass a parseable ISO `updatedAfter` to return only threads whose `updatedAt`, latest run `requestedAt`, or latest run `completedAt` is strictly newer. Provider subagent threads are left out unless `includeSubagents: true`. The result echoes it, includes `total` and `hasMore`, and provides a `serverTime` read boundary: use that boundary as the next `updatedAfter` only when `hasMore` is false; when true, repeat the same `updatedAfter` with a larger `limit`. Read-only.',
  parameters: ThreadsThreadListInput,
  success: ThreadsThreadListResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadTranscriptTool = Tool.make("thread_transcript", {
  description:
    "Read a thread's messages, one page of turns at a time, newest turns first. Pass `page.beforeCursor` back to read older turns. Read-only.",
  parameters: ThreadsTranscriptInput,
  success: ThreadsTranscriptResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read thread transcript")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSummariesTool = Tool.make("thread_summaries", {
  description:
    "Read the summaries a thread already produced, without running a model: the assistant's final message of the latest run and the results its subagents reported when they finished. Pass exactly one of `threadId` for the existing single-thread response or `threadIds` for `{ summaries: [...] }` in request order; batches accept 1–20 IDs and fail atomically if any thread is missing or archived. pendingRequests remains authoritative for actionable questions. Read-only.",
  parameters: ThreadsSummariesInput,
  success: ThreadsSummariesToolResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get thread summaries")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadStatusTool = Tool.make("thread_status", {
  description:
    "Report where a thread stands: running, finished, needs-you (waiting on the user for an approval, a question, or a plan), failed, idle, or archived. `pendingRequests` lists what it is waiting on, in its own words; `latestRun` is the run to pass as thread_interrupt.turnId. Read-only.",
  parameters: ThreadsThreadReadInput,
  success: ThreadsThreadStatus,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get thread status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSearchTool = Tool.make("thread_search", {
  description:
    "Find active threads by text in the title, any user message, or any assistant reply. Matching is case-insensitive, normalizes repeated and Unicode whitespace, and accepts phrases across transcript line breaks. Returns the snippet that matched per thread and identifies the source as title, user, or assistant; follow up with thread_detail or thread_transcript. Read-only.",
  parameters: ThreadsSearchInput,
  success: ThreadsSearchResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadDetailTool = Tool.make("thread_detail", {
  description:
    "Everything about one thread that thread_status leaves out: its model, permission and interaction modes, branch, worktree, linked pull request, whether it is pinned, snoozed, settled or archived, who created it and from where, and what it is waiting on. Read this before thread_update. Read-only.",
  parameters: ThreadsThreadReadInput,
  success: ThreadsThreadDetail,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get thread detail")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadDiffTool = Tool.make("thread_diff", {
  description:
    "Read the code a thread changed, as a unified diff between its turn checkpoints. Pass `turnCount` for one turn, `fromTurnCount` + `toTurnCount` for a range, or `full: true` with `toTurnCount` for everything the thread changed. The patch is truncated at `maxChars` (20000 by default) and says so. Read-only.",
  parameters: ThreadsDiffInput,
  success: ThreadsDiffResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read thread diff")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadForwardTool = Tool.make("thread_forward", {
  description: EXOWATT_THREAD_TOOL_DESCRIPTIONS.threadForward,
  parameters: ThreadsForwardInput,
  success: ThreadsForwardResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Forward message to thread")
  .annotate(Tool.Destructive, false);

export const ThreadCreateTool = Tool.make("thread_create", {
  description: EXOWATT_THREAD_TOOL_DESCRIPTIONS.threadCreate,
  parameters: ThreadsCreateThreadInput,
  success: ThreadsCreateThreadResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create thread")
  .annotate(Tool.Destructive, false);

export const ThreadUpdateTool = Tool.make("thread_update", {
  description:
    "Change a thread without sending it a message: rename it (or `regenerateTitle: true` to have the server re-derive one), switch its model, permission mode or interaction mode for the next turn, set its branch or worktree, pin or unpin it, snooze it until a time or wake it, settle or unsettle it, archive or restore it. Pass only the fields to change. Does not interrupt a running turn.",
  parameters: ThreadsUpdateInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadRespondTool = Tool.make("thread_respond", {
  description:
    "Pass the user's answer to a thread that has a real pending approval or question. For an approval pass `decision`; for a question pass `answers` keyed by question id (see thread_status.pendingRequests). `requestId` may be omitted when the thread has exactly one pending request. Phi `awaiting-human` hand-backs are passive: use thread_forward to start the next turn with the user's text, not thread_respond. Only pass through what the user actually said; never decide for them.",
  parameters: ThreadsRespondInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Respond on the user's behalf")
  .annotate(Tool.Destructive, false);

export const ThreadInterruptTool = Tool.make("thread_interrupt", {
  description:
    "Stop the turn a thread is running, the way the composer's stop button does. The thread keeps its session and history, so it can be sent a new message right after. Pass `turnId` (thread_status.latestRun.runId) to be sure you are stopping the run you looked at.",
  parameters: ThreadsInterruptInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt running turn")
  .annotate(Tool.Destructive, false);

export const ThreadStopTool = Tool.make("thread_stop", {
  description:
    "Shut down a thread's provider session, freeing the model process, without archiving the thread or losing its history. The next message starts a fresh session. Use thread_interrupt to stop just the running turn.",
  parameters: ThreadsThreadTargetInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop provider session")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadDeleteTool = Tool.make("thread_delete", {
  description:
    "Delete a thread and its history. Destructive and permanent: there is no undo and no archive to restore from; prefer thread_update with `archived: true`. Pass `confirm: true`. Ask the user first.",
  parameters: ThreadsDeleteThreadInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete thread")
  .annotate(Tool.Destructive, true);

export const ThreadPinTool = Tool.make("thread_pin", {
  description:
    "Pin a thread to the top of the sidebar. Pass `orderKey` to place it in the pinned order; omit it to let the block fall back to creation order.",
  parameters: ThreadsPinInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Pin thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadUnpinTool = Tool.make("thread_unpin", {
  description: "Unpin a thread, returning it to the ordinary sidebar list.",
  parameters: ThreadsThreadTargetInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unpin thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadPinReorderTool = Tool.make("thread_pin_reorder", {
  description:
    "Move an already-pinned thread within the pinned order by writing its `orderKey`. Pinned threads sort by plain string comparison of these keys, so only this thread changes; read the neighbours' keys from thread_detail and pick one that sorts between them.",
  parameters: ThreadsPinReorderInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Reorder pinned thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSnoozeTool = Tool.make("thread_snooze", {
  description:
    "Hide a thread from the active list until a time you name (`snoozedUntil`, ISO). Nothing is stopped or lost; the thread simply stops asking for attention until then.",
  parameters: ThreadsSnoozeInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Snooze thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadUnsnoozeTool = Tool.make("thread_unsnooze", {
  description: "Wake a snoozed thread now, before its snooze time.",
  parameters: ThreadsThreadTargetInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wake snoozed thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadRevertTool = Tool.make("thread_revert", {
  description:
    "Roll a thread's workspace back to one of its turn checkpoints, discarding every file change made after it. Destructive: read thread_diff first, pass `confirm: true`, and only when the user asked.",
  parameters: ThreadsRevertInput,
  success: ThreadsMutationResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Revert to checkpoint")
  .annotate(Tool.Destructive, true);

export const ThreadListenTool = Tool.make("thread_listen", {
  description:
    "Wait on a thread until it reaches a milestone: finished, needs-you, or failed. Blocks until then or until timeoutMs elapses, in which case it returns `timeout` and you should call it again. Stay attached until a real milestone; do not report progress in between.",
  parameters: ThreadsListenInput,
  success: ThreadsListenResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for thread milestone")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const EnvironmentListTool = Tool.make("environment_list", {
  description: EXOWATT_THREAD_TOOL_DESCRIPTIONS.environmentList,
  parameters: Tool.EmptyParams,
  success: ThreadsEnvironmentListResult,
  failure: ThreadsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List linked environments")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadsToolkit = Toolkit.make(
  ProjectListTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ThreadListTool,
  ThreadSearchTool,
  ThreadStatusTool,
  ThreadDetailTool,
  ThreadTranscriptTool,
  ThreadSummariesTool,
  ThreadDiffTool,
  ThreadForwardTool,
  ThreadCreateTool,
  ThreadUpdateTool,
  ThreadRespondTool,
  ThreadInterruptTool,
  ThreadStopTool,
  ThreadDeleteTool,
  ThreadPinTool,
  ThreadUnpinTool,
  ThreadPinReorderTool,
  ThreadSnoozeTool,
  ThreadUnsnoozeTool,
  ThreadRevertTool,
  ThreadListenTool,
  EnvironmentListTool,
);
