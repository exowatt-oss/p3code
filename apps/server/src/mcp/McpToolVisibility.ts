// Exowatt: the environment-session MCP principal and per-principal tool visibility on `/mcp`.
// An environment session (`t3 agent token`) has no thread, so it holds only the
// "command-center" capability and every upstream `t3_*`/`preview_*`/`device_*` tool refuses it.
// In-app provider sessions get "command-center" too while agent-tool settings allow it.
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  EXOWATT_THREADS_FORWARDABLE_TOOLS,
  EXOWATT_THREADS_MCP_CAPABILITY,
  type ExowattPeerInbound,
  isExowattPeerSessionLabel,
  isExowattReversePeerSessionLabel,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
import { HttpBody, HttpServerResponse } from "effect/http";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import { ClientSettingsToolkit } from "./toolkits/clientSettings/tools.ts";
import { HarnessToolkit } from "./toolkits/harness/tools.ts";
import { SettingsToolkit } from "./toolkits/settings/tools.ts";
import { ThreadFocusToolkit } from "./toolkits/threadFocus/tools.ts";
import { ThreadHubToolkit } from "./toolkits/threadHub/tools.ts";
import { ThreadSignalsToolkit } from "./toolkits/threadSignals/tools.ts";
import { ThreadsToolkit } from "./toolkits/threads/tools.ts";

/** Tool names of the P3 toolkits, the ones gated by "command-center". */
export const EXOWATT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  [
    ThreadsToolkit,
    ThreadFocusToolkit,
    ThreadHubToolkit,
    HarnessToolkit,
    SettingsToolkit,
    ClientSettingsToolkit,
    ThreadSignalsToolkit,
  ].flatMap((toolkit) => Object.keys(toolkit.tools)),
);

/** The experimental thread-signal tools, also gated by the "thread-signals" capability. */
export const EXOWATT_THREAD_SIGNAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(ThreadSignalsToolkit.tools),
);

/** The only tools a linked environment's session may list or call. */
export const EXOWATT_PEER_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...EXOWATT_THREADS_FORWARDABLE_TOOLS,
  "environment_list",
]);

const FORWARDABLE_TOOL_NAMES: ReadonlySet<string> = new Set(EXOWATT_THREADS_FORWARDABLE_TOOLS);
const THREADS_LOCAL_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(ThreadsToolkit.tools).filter((name) => !FORWARDABLE_TOOL_NAMES.has(name)),
);

const isPeerScope = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.environmentSession?.peer === true;

export const makeEnvironmentSessionScope = (input: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: EnvironmentAuth.AuthenticatedSession["sessionId"];
  readonly subject: string;
  readonly issuedAt: number;
  readonly peer?: boolean;
  /** A reverse (receiver-gated) peer session; see `McpInvocationScope.environmentSession.gated`. */
  readonly gated?: boolean;
  readonly peerCeiling?: RuntimeMode;
}): McpInvocationContext.McpInvocationScope => ({
  environmentId: input.environmentId,
  requestNamespace: `environment-session:${input.sessionId}`,
  thread: undefined,
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>([EXOWATT_THREADS_MCP_CAPABILITY]),
  issuedAt: input.issuedAt,
  environmentSession: {
    sessionId: input.sessionId,
    subject: input.subject,
    ...(input.peer === true ? { peer: true } : {}),
    ...(input.gated === true ? { gated: true } : {}),
    ...(input.gated === true && input.peerCeiling !== undefined
      ? { peerCeiling: input.peerCeiling }
      : {}),
  },
});

/**
 * `orchestration:operate` is the bar: the WebSocket needs it to dispatch the same commands.
 * A `p3-peer:` label restricts the session to the cross-environment Threads tools. Only its
 * *reverse* form (`p3-peer:reverse `) is further bounded by this server's own
 * `exowattPeerInbound`; a forward label is admitted exactly as a plain `t3 agent token`, with no ceiling.
 */
export const environmentSessionMcpScope = (input: {
  readonly environmentId: EnvironmentId;
  readonly session: EnvironmentAuth.AuthenticatedSession;
  readonly issuedAt: number;
  readonly peerInbound?: ExowattPeerInbound;
}): McpInvocationContext.McpInvocationScope | "insufficient_scope" | "peer_inbound_off" => {
  if (!input.session.scopes.includes(AuthOrchestrationOperateScope)) return "insufficient_scope";
  const peer = isExowattPeerSessionLabel(input.session.clientLabel);
  const gated = isExowattReversePeerSessionLabel(input.session.clientLabel);
  const inbound = input.peerInbound ?? "off";
  if (gated && inbound === "off") return "peer_inbound_off";
  return makeEnvironmentSessionScope({
    environmentId: input.environmentId,
    sessionId: input.session.sessionId,
    subject: input.session.subject,
    issuedAt: input.issuedAt,
    peer,
    gated,
    ...(gated && inbound !== "off" ? { peerCeiling: inbound } : {}),
  });
};

/** Whether in-app agent sessions get the P3 toolkits (Settings › Sharing & access). */
export const providerSessionsGetCommandCenter = (
  settings: Pick<ServerSettings, "enableAgentThreadTools" | "enableAgentP3Tools">,
): boolean => settings.enableAgentThreadTools || settings.enableAgentP3Tools;

/** Add "command-center" to a provider-session scope; the scope is otherwise untouched. */
export const withCommandCenter = (
  scope: McpInvocationContext.McpInvocationScope,
): McpInvocationContext.McpInvocationScope =>
  scope.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)
    ? scope
    : {
        ...scope,
        capabilities: new Set([...scope.capabilities, EXOWATT_THREADS_MCP_CAPABILITY]),
      };

/** Add "thread-signals" to a provider or environment-session scope when the setting is on. */
export const withThreadSignals = (
  scope: McpInvocationContext.McpInvocationScope,
  settings: Pick<ServerSettings, "exowattThreadSignals">,
): McpInvocationContext.McpInvocationScope =>
  !settings.exowattThreadSignals || scope.capabilities.has("thread-signals")
    ? scope
    : { ...scope, capabilities: new Set([...scope.capabilities, "thread-signals"]) };

/**
 * Which tools a scope sees in `tools/list`. An environment session sees only the P3
 * toolkits; a provider session sees the upstream tools plus the P3 toolkits when it holds
 * "command-center". Handlers re-check capabilities on call, so this is presentation only.
 */
export const isMcpToolVisibleToScope = (
  scope: McpInvocationContext.McpInvocationScope,
  toolName: string,
): boolean =>
  isPeerScope(scope)
    ? EXOWATT_PEER_SESSION_TOOL_NAMES.has(toolName) &&
      scope.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)
    : EXOWATT_THREAD_SIGNAL_TOOL_NAMES.has(toolName)
      ? scope.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY) &&
        scope.capabilities.has("thread-signals")
      : EXOWATT_MCP_TOOL_NAMES.has(toolName)
        ? scope.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)
        : scope.environmentSession === undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why `/mcp` refuses this call before any handler runs, or null. Handlers can't see an
 * argument their schema drops, so `environmentId` on a local-only Threads tool is caught here.
 */
export const mcpToolCallRefusal = (
  scope: McpInvocationContext.McpInvocationScope | undefined,
  toolName: string,
  args: unknown,
): string | null => {
  if (scope !== undefined && isPeerScope(scope) && !EXOWATT_PEER_SESSION_TOOL_NAMES.has(toolName)) {
    return `${toolName} is not available to a linked environment; this credential may only call ${[...EXOWATT_PEER_SESSION_TOOL_NAMES].join(", ")}.`;
  }
  if (
    THREADS_LOCAL_ONLY_TOOL_NAMES.has(toolName) &&
    isRecord(args) &&
    args.environmentId !== undefined
  ) {
    return `${toolName} only acts on this environment and does not take environmentId; only ${EXOWATT_THREADS_FORWARDABLE_TOOLS.join(", ")} reach a linked environment.`;
  }
  return null;
};

/**
 * Rewrite the JSON text of a JSON-RPC `tools/list` result so it lists only
 * the tools the scope may call. Returns `null` when the text is not a
 * `tools/list` result or nothing would change, so callers keep the bytes.
 */
export const filterMcpToolsListJson = (
  scope: McpInvocationContext.McpInvocationScope,
  text: string,
): string | null => {
  if (!text.includes('"tools"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.result) || !Array.isArray(parsed.result.tools)) {
    return null;
  }
  const tools = parsed.result.tools;
  const visible = tools.filter(
    (tool) =>
      !isRecord(tool) || typeof tool.name !== "string" || isMcpToolVisibleToScope(scope, tool.name),
  );
  if (visible.length === tools.length) return null;
  return JSON.stringify({ ...parsed, result: { ...parsed.result, tools: visible } });
};

/**
 * The Effect McpServer answers `tools/list` for every client from one shared
 * registry, so the per-principal filter runs on the response. Its HTTP
 * transport answers `tools/list` with a materialised `application/json` body,
 * the only shape rewritten here; anything else passes through unchanged.
 */
export const filterMcpToolsListResponse = (
  scope: McpInvocationContext.McpInvocationScope,
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const body = response.body;
  if (body._tag !== "Uint8Array" || !body.contentType.startsWith("application/json")) {
    return response;
  }
  const rewritten = filterMcpToolsListJson(scope, new TextDecoder().decode(body.body));
  if (rewritten === null) return response;
  return HttpServerResponse.setBody(response, HttpBody.text(rewritten, body.contentType));
};

export const PEER_INBOUND_OFF_MESSAGE =
  "This environment does not accept agents from your other environments; turn on Settings › Sharing & access › Agents from my other environments may act here on this environment.";

export const peerInboundOffResponse = () =>
  HttpServerResponse.jsonUnsafe(
    { error: "peer_inbound_off", message: PEER_INBOUND_OFF_MESSAGE },
    { status: 403, headers: { "cache-control": "no-store" } },
  );

export const insufficientScopeResponse = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "insufficient_scope",
      message: `The bearer session must hold the ${AuthOrchestrationOperateScope} scope to use the MCP tools.`,
    },
    {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer scope="${AuthOrchestrationOperateScope}"`,
      },
    },
  );
