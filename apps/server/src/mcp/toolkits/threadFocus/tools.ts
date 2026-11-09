// Exowatt distro: the thread-focus toolkit. Tool names are a wire contract;
// keep them stable.
import { ThreadFocusInput, ThreadFocusResult, ThreadFocusToolError } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  ServerSettings.ServerSettingsService,
];

export const ThreadFocusTool = Tool.make("thread_focus", {
  description:
    'Bring a thread on screen: every connected P3 client of this environment navigates to it. Use it when the user should look at a thread now, e.g. one that needs them. It does not pin, reorder or modify the thread; on macOS the caller still brings the P3 window forward (`open -a "P3 Code"`).',
  parameters: ThreadFocusInput,
  success: ThreadFocusResult,
  failure: ThreadFocusToolError,
  dependencies,
})
  .annotate(Tool.Title, "Focus thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadFocusToolkit = Toolkit.make(ThreadFocusTool);
