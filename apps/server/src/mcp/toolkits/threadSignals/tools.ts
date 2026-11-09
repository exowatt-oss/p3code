// Exowatt distro: the experimental thread-signal toolkit an orchestrator thread
// reads its workers through. Tool names are a wire contract; keep them stable.
import {
  ThreadSignalAckInput,
  ThreadSignalAckResult,
  ThreadSignalEmitInput,
  ThreadSignalEmitResult,
  ThreadSignalsListInput,
  ThreadSignalsListResult,
  ThreadSignalsToolError,
  ThreadUiRenderInput,
  ThreadUiRenderResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ExowattThreadSignalStore from "../../../exowattThreadSignals/ExowattThreadSignalStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  ExowattThreadSignalStore.ExowattThreadSignalStore,
];

const SignalEmitTool = Tool.make("t3_signal_emit", {
  description:
    "Report up to the user's orchestrator at any meaningful step, not just at the end. green = something got done (say what, link the output). yellow = the user must act: a sign-in or unlock, a hands-on task on one of their machines, or an important question you could not answer yourself. red = an error you could not recover from. One crisp line per signal; it lands on your own thread, where an orchestrator thread reads it with t3_thread_signals.",
  parameters: ThreadSignalEmitInput,
  success: ThreadSignalEmitResult,
  failure: ThreadSignalsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Emit thread signal")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const ThreadSignalsListTool = Tool.make("t3_thread_signals", {
  description:
    "List the open green/yellow/red signals threads raised (oldest first), to brief the user without reading every thread. Filter by threadId or lane; includeAcked adds recently acked ones.",
  parameters: ThreadSignalsListInput,
  success: ThreadSignalsListResult,
  failure: ThreadSignalsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread signals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SignalAckTool = Tool.make("t3_signal_ack", {
  description:
    "Ack (close) thread signals once handled: pass ids, or threadId to ack every open signal of that thread. Acked signals leave the open list.",
  parameters: ThreadSignalAckInput,
  success: ThreadSignalAckResult,
  failure: ThreadSignalsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ack thread signals")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// Generated UI was removed; kept registered so agents that still call it get a hint, not an unknown-tool error.
const UiRenderTool = Tool.make("t3_ui_render", {
  description:
    "Not available in this build (generated UI was removed): answer in plain Markdown instead.",
  parameters: ThreadUiRenderInput,
  success: ThreadUiRenderResult,
  failure: ThreadSignalsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Render UI panel (unavailable)")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSignalsToolkit = Toolkit.make(
  SignalEmitTool,
  ThreadSignalsListTool,
  SignalAckTool,
  UiRenderTool,
);
