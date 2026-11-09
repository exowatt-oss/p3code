// Exowatt distro: handlers for the thread-signal toolkit. Each is one store call.
import {
  EXOWATT_THREADS_MCP_CAPABILITY,
  type ThreadSignalAckInput,
  type ThreadSignalEmitInput,
  type ThreadSignalsListInput,
  ThreadSignalsToolError,
  type ThreadUiRenderInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ExowattThreadSignalStore from "../../../exowattThreadSignals/ExowattThreadSignalStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadSignalsToolkit } from "./tools.ts";

type ToolName = ThreadSignalsToolError["tool"];

const toolError = (tool: ToolName, detail: string) => new ThreadSignalsToolError({ tool, detail });

const OFF_DETAIL =
  "thread signals are off on this environment (server setting exowattThreadSignals); end your message with 🟢/🟡/🔴 lines instead";

/** Both capabilities, or the tool's own error. */
const requireSignals = Effect.fn("ThreadSignalsToolkit.requireSignals")(function* (tool: ToolName) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
    return yield* toolError(
      tool,
      `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`,
    );
  }
  if (!invocation.capabilities.has("thread-signals")) return yield* toolError(tool, OFF_DETAIL);
  return invocation;
});

/** Put one signal on the caller's thread (or `threadId` for an outside caller). */
const emitOnThread = Effect.fn("ThreadSignalsToolkit.emitOnThread")(function* (
  tool: "t3_signal_emit",
  input: Omit<ExowattThreadSignalStore.EmitSignalInput, "threadId"> & {
    readonly threadId?: ThreadSignalEmitInput["threadId"];
  },
) {
  const invocation = yield* requireSignals(tool);
  const threadId = input.threadId ?? McpInvocationContext.callerThreadId(invocation);
  if (threadId === null) return yield* toolError(tool, "threadId is required outside a thread");
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(threadId)
    .pipe(Effect.mapError((cause) => toolError(tool, cause.message)));
  if (shell === null || shell.deletedAt !== null) {
    return yield* toolError(tool, `thread ${threadId} not found`);
  }
  const store = yield* ExowattThreadSignalStore.ExowattThreadSignalStore;
  const signal = yield* store
    .emit({ ...input, threadId })
    .pipe(Effect.mapError((cause) => toolError(tool, cause.message)));
  return { signal };
});

const signalEmit = Effect.fn("ThreadSignalsToolkit.t3_signal_emit")(function* (
  input: ThreadSignalEmitInput,
) {
  return yield* emitOnThread("t3_signal_emit", {
    threadId: input.threadId,
    lane: input.lane,
    title: input.title,
    detail: input.detail,
    links: input.links,
  });
});

export const UI_RENDER_UNAVAILABLE =
  "Generated UI is not available in this build; nothing was shown or stored. Answer the user in plain Markdown instead.";

// No-op: stores nothing and succeeds, so agents with stale prompts fall back to Markdown.
const uiRender = (_input: ThreadUiRenderInput) =>
  Effect.succeed({ message: UI_RENDER_UNAVAILABLE });

const threadSignalsList = Effect.fn("ThreadSignalsToolkit.t3_thread_signals")(function* (
  input: ThreadSignalsListInput,
) {
  yield* requireSignals("t3_thread_signals");
  const store = yield* ExowattThreadSignalStore.ExowattThreadSignalStore;
  const signals = yield* store
    .list(input)
    .pipe(Effect.mapError((cause) => toolError("t3_thread_signals", cause.message)));
  return { signals };
});

const signalAck = Effect.fn("ThreadSignalsToolkit.t3_signal_ack")(function* (
  input: ThreadSignalAckInput,
) {
  yield* requireSignals("t3_signal_ack");
  if ((input.ids === undefined || input.ids.length === 0) && input.threadId === undefined) {
    return yield* toolError("t3_signal_ack", "pass ids or threadId");
  }
  const store = yield* ExowattThreadSignalStore.ExowattThreadSignalStore;
  return yield* store
    .ack(input)
    .pipe(Effect.mapError((cause) => toolError("t3_signal_ack", cause.message)));
});

export const threadSignalsHandlers = {
  t3_signal_emit: signalEmit,
  t3_thread_signals: threadSignalsList,
  t3_signal_ack: signalAck,
  t3_ui_render: uiRender,
} satisfies Parameters<typeof ThreadSignalsToolkit.toLayer>[0];

// exowatt: declared through McpToolAccess so `/mcp` registers them with an access rule.
const refuse = (tool: ToolName) => () =>
  toolError(tool, `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`);

export const ThreadSignalsToolkitHandlersLive = McpToolAccess.toLayer(ThreadSignalsToolkit, {
  t3_signal_emit: McpToolAccess.usesCommandCenter(refuse("t3_signal_emit"), signalEmit),
  t3_thread_signals: McpToolAccess.usesCommandCenter(
    refuse("t3_thread_signals"),
    threadSignalsList,
  ),
  t3_signal_ack: McpToolAccess.usesCommandCenter(refuse("t3_signal_ack"), signalAck),
  t3_ui_render: McpToolAccess.usesCommandCenter(refuse("t3_ui_render"), uiRender),
} satisfies McpToolAccess.Handlers<typeof ThreadSignalsToolkit.tools>);
