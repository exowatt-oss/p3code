// Exowatt distro: the thread Hub toolkit. Tool names are a wire contract;
// keep them stable.
import { ThreadHubPinInput, ThreadHubPinResult, ThreadHubToolError } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ExowattThreadHubStore from "../../../exowattThreadHub/ExowattThreadHubStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  ExowattThreadHubStore.ExowattThreadHubStore,
];

const ThreadHubPinTool = Tool.make("thread_hub_pin", {
  description:
    'Pin, hide or add an item in a thread\'s Hub panel (its Outputs and Sources). Pinned items sort to the top, hidden ones fold behind "Show N hidden". Set title (with url, path or note) to add a link, file or note by hand, e.g. pin the deliverable you just produced as an output. Every connected P3 client updates live. Keys: the URL for links and pages, the path for files, `host/repo#n` for pull requests, the commit sha, `server/tool` for MCP tools, any unique id for notes.',
  parameters: ThreadHubPinInput,
  success: ThreadHubPinResult,
  failure: ThreadHubToolError,
  dependencies,
})
  .annotate(Tool.Title, "Pin to thread Hub")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadHubToolkit = Toolkit.make(ThreadHubPinTool);
