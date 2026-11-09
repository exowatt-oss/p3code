// Exowatt distro: handler for the thread Hub toolkit. One store call; the
// store publishes the change to every subscribed client.
import {
  EXOWATT_THREADS_MCP_CAPABILITY,
  type ThreadHubPinInput,
  type ThreadHubPinResult,
  ThreadHubToolError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ExowattThreadHubStore from "../../../exowattThreadHub/ExowattThreadHubStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadHubToolkit } from "./tools.ts";

type Deps =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagement.ThreadManagementService
  | ExowattThreadHubStore.ExowattThreadHubStore;

const toolError = (threadId: ThreadId | null, detail: string) =>
  new ThreadHubToolError({ tool: "thread_hub_pin", threadId, detail });

const threadHubPin = Effect.fn("ThreadHubToolkit.thread_hub_pin")(function* (
  input: ThreadHubPinInput,
): Effect.fn.Return<ThreadHubPinResult, ThreadHubToolError, Deps> {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
    return yield* toolError(
      null,
      `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`,
    );
  }
  const manualFields = input.url ?? input.path ?? input.note;
  if (input.title === undefined && manualFields !== undefined) {
    return yield* toolError(input.threadId, "title is required to add an item by hand");
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(input.threadId)
    .pipe(Effect.mapError((cause) => toolError(input.threadId, cause.message)));
  if (shell === null || shell.deletedAt !== null) {
    return yield* toolError(input.threadId, "thread not found");
  }
  const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
  return yield* store
    .upsert({
      threadId: input.threadId,
      kind: input.kind,
      key: input.key,
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
      ...(input.title === undefined
        ? {}
        : {
            manual: {
              title: input.title,
              ...(input.url === undefined ? {} : { url: input.url }),
              ...(input.path === undefined ? {} : { path: input.path }),
              ...(input.note === undefined ? {} : { note: input.note }),
            },
          }),
    })
    .pipe(Effect.mapError((cause) => toolError(input.threadId, cause.message)));
});

export const threadHubHandlers = {
  thread_hub_pin: threadHubPin,
} satisfies Parameters<typeof ThreadHubToolkit.toLayer>[0];

// exowatt: declared through McpToolAccess so `/mcp` registers them with an access rule.
const refuse = () => () =>
  toolError(null, `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`);

export const ThreadHubToolkitHandlersLive = McpToolAccess.toLayer(ThreadHubToolkit, {
  thread_hub_pin: McpToolAccess.usesCommandCenter(refuse(), threadHubPin),
} satisfies McpToolAccess.Handlers<typeof ThreadHubToolkit.tools>);
