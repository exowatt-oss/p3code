// Exowatt distro: handler for the thread-focus toolkit. The request is one server setting
// (`exowattThreadFocusRequest`) written through the ordinary settings patch, so it streams
// to every connected client. `requestedAt` is the generation clients key their once-only
// navigation on, so a client can ignore a request it sees long after it was made.
import {
  EXOWATT_THREADS_MCP_CAPABILITY,
  type ThreadFocusInput,
  type ThreadFocusResult,
  ThreadFocusToolError,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadFocusToolkit } from "./tools.ts";

type Deps =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagement.ThreadManagementService
  | ServerSettings.ServerSettingsService;

const toolError = (threadId: ThreadId | null, detail: string) =>
  new ThreadFocusToolError({ tool: "thread_focus", threadId, detail });

const threadFocus = Effect.fn("ThreadFocusToolkit.thread_focus")(function* (
  input: ThreadFocusInput,
): Effect.fn.Return<ThreadFocusResult, ThreadFocusToolError, Deps> {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
    return yield* toolError(
      null,
      `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`,
    );
  }
  // Refuse unknown or archived threads here rather than sending every client
  // to a page that does not exist.
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(input.threadId)
    .pipe(Effect.mapError((cause) => toolError(input.threadId, cause.message)));
  if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
    return yield* toolError(input.threadId, "thread not found or archived");
  }
  const settings = yield* ServerSettings.ServerSettingsService;
  const requestedAt = DateTime.formatIso(yield* DateTime.now);
  yield* settings
    .updateSettings({ exowattThreadFocusRequest: { threadId: input.threadId, requestedAt } })
    .pipe(Effect.mapError((cause) => toolError(input.threadId, cause.message)));
  return { threadId: input.threadId, requestedAt };
});

export const threadFocusHandlers = {
  thread_focus: threadFocus,
} satisfies Parameters<typeof ThreadFocusToolkit.toLayer>[0];

// exowatt: declared through McpToolAccess so `/mcp` registers them with an access rule.
const refuse = () => () =>
  toolError(null, `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`);

export const ThreadFocusToolkitHandlersLive = McpToolAccess.toLayer(ThreadFocusToolkit, {
  thread_focus: McpToolAccess.usesCommandCenter(refuse(), threadFocus),
} satisfies McpToolAccess.Handlers<typeof ThreadFocusToolkit.tools>);
