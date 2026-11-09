// Exowatt distro: handlers for the harness / connector / feads toolkit. Each is the body of
// the matching WebSocket RPC in `ws.ts` minus the stream: a tool takes the poller's latest
// snapshot and returns. `connector_add` is the one non-passthrough: it does what Customize
// › MCP "Add to" does (mint a token for our own `/mcp`, write one http entry).
import {
  EXOWATT_CONNECTOR_CATALOG,
  EXOWATT_P3_MCP_PATH,
  type ExowattConnectorAddInput,
  type ExowattConnectorAddResult,
  type ExowattConnectorAutoConnectReport,
  type ExowattConnectorCatalogEntry,
  type ExowattConnectorListResult,
  type ExowattFeadsAckInput,
  type ExowattFeadsAckResult,
  type ExowattFeadsAgentwatchSnapshot,
  type ExowattFeadsConfigureInput,
  type ExowattFeadsError,
  type ExowattFeadsInboxSnapshot,
  type ExowattFeadsMyIssuesSnapshot,
  type ExowattFeadsStatus,
  type ExowattFeadsTestResult,
  type ExowattHarnessAssetInventoryResult,
  type ExowattHarnessAssetListInput,
  type ExowattHarnessAssetToggleInput,
  type ExowattHarnessConfigError,
  type ExowattHarnessId,
  type ExowattHarnessMcpAddInput,
  type ExowattHarnessMcpConnectInput,
  type ExowattHarnessMcpConnectResult,
  type ExowattHarnessMcpInventory,
  type ExowattHarnessMcpInventoryResult,
  type ExowattHarnessMcpStatusInput,
  type ExowattHarnessMcpStatusResult,
  type ExowattHarnessMcpToggleInput,
  type ExowattHarnessMcpToggleResult,
  HarnessToolError,
  type HarnessToolName,
  EXOWATT_THREADS_MCP_CAPABILITY,
} from "@t3tools/contracts";
import { normalizeMcpUrl } from "@t3tools/shared/mcpUrl";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { ChildProcessSpawner } from "effect/process";

import type * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../../config.ts";
import * as ExowattConnectorAutoConnect from "../../../exowattConnectorAutoConnect.ts";
import * as ExowattConnectors from "../../../exowattConnectors.ts";
import * as ExowattHarnessConfig from "../../../exowattHarnessConfig.ts";
import * as FeadsBridge from "../../../feads/FeadsBridge.ts";
import * as FeadsService from "../../../feads/FeadsService.ts";
import type * as HarnessLaunchEnvironment from "../../../provider/HarnessLaunchEnvironment.ts";
import { readPersistedServerRuntimeState } from "../../../serverRuntimeState.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HarnessToolkit } from "./tools.ts";

type Deps =
  | McpInvocationContext.McpInvocationContext
  | ExowattConnectorAutoConnect.ExowattConnectorAutoConnect
  | HarnessLaunchEnvironment.HarnessLaunchEnvironment
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | EnvironmentAuth.EnvironmentAuth
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | FeadsService.FeadsService
  | FeadsBridge.FeadsBridge;

const toolError = (tool: HarnessToolName, harness: ExowattHarnessId | null, detail: string) =>
  new HarnessToolError({ tool, harness, detail });

/**
 * These tools reconfigure the harnesses on the machine and mint credentials for them, so
 * only a human-minted bearer session (`t3 agent token`) may call them. An in-app provider
 * session must not rewrite its own harness config or issue itself a token, so it gets a
 * refusal even though the tools are listed for it.
 */
export const requireP3Access = Effect.fn("HarnessToolkit.requireP3Access")(function* (
  tool: HarnessToolName,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
    return yield* toolError(
      tool,
      null,
      `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability; harness tools need it.`,
    );
  }
  return invocation;
});

/** Phi is driven through its own binary, whose path the user can override. */
const phiBinaryPath = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  return yield* serverSettings.getSettings.pipe(
    Effect.map(ExowattHarnessConfig.phiBinaryPathFromSettings),
    Effect.orElseSucceed(() => undefined),
  );
});

/** Phi's binary plus how to reach the Claude Code and Codex CLIs, for status and login. */
const harnessCliOptions = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  return yield* serverSettings.getSettings.pipe(
    Effect.map((settings) => ExowattHarnessConfig.harnessCliOptionsFromSettings(settings)),
    Effect.orElseSucceed(() => ExowattHarnessConfig.harnessCliOptionsFromSettings(undefined)),
  );
});

const harnessConfigError =
  (tool: HarnessToolName, harness: ExowattHarnessId | null) => (cause: ExowattHarnessConfigError) =>
    toolError(tool, harness, cause.reason);

const feadsError = (tool: HarnessToolName) => (cause: ExowattFeadsError) =>
  toolError(tool, null, cause.reason);

const harnessMcpList = Effect.fn("HarnessToolkit.harness_mcp_list")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattHarnessMcpInventoryResult, HarnessToolError, Deps> {
  yield* requireP3Access("harness_mcp_list");
  return yield* ExowattHarnessConfig.listHarnessMcpConfigs().pipe(
    Effect.mapError(harnessConfigError("harness_mcp_list", null)),
  );
});

const harnessMcpAdd = Effect.fn("HarnessToolkit.harness_mcp_add")(function* (
  input: ExowattHarnessMcpAddInput,
): Effect.fn.Return<ExowattHarnessMcpInventoryResult, HarnessToolError, Deps> {
  yield* requireP3Access("harness_mcp_add");
  return yield* ExowattHarnessConfig.addHarnessMcpServer(input).pipe(
    Effect.mapError(harnessConfigError("harness_mcp_add", input.harness)),
  );
});

const harnessMcpToggle = Effect.fn("HarnessToolkit.harness_mcp_toggle")(function* (
  input: ExowattHarnessMcpToggleInput,
): Effect.fn.Return<ExowattHarnessMcpToggleResult, HarnessToolError, Deps> {
  yield* requireP3Access("harness_mcp_toggle");
  const binaryPath = yield* phiBinaryPath;
  return yield* ExowattHarnessConfig.toggleHarnessMcpServer(input, binaryPath).pipe(
    Effect.mapError(harnessConfigError("harness_mcp_toggle", input.harness)),
  );
});

const harnessMcpStatus = Effect.fn("HarnessToolkit.harness_mcp_status")(function* (
  input: ExowattHarnessMcpStatusInput,
): Effect.fn.Return<ExowattHarnessMcpStatusResult, HarnessToolError, Deps> {
  yield* requireP3Access("harness_mcp_status");
  const { phiBinaryPath, claude, codex } = yield* harnessCliOptions;
  return yield* ExowattHarnessConfig.getHarnessMcpRuntimeStatus(
    input,
    phiBinaryPath,
    claude,
    codex,
  );
});

const harnessMcpConnect = Effect.fn("HarnessToolkit.harness_mcp_connect")(function* (
  input: ExowattHarnessMcpConnectInput,
): Effect.fn.Return<ExowattHarnessMcpConnectResult, HarnessToolError, Deps> {
  yield* requireP3Access("harness_mcp_connect");
  const { phiBinaryPath, claude, codex } = yield* harnessCliOptions;
  return yield* ExowattHarnessConfig.connectHarnessMcpServer(input, phiBinaryPath, claude, codex);
});

const harnessAssetList = Effect.fn("HarnessToolkit.harness_asset_list")(function* (
  input: ExowattHarnessAssetListInput,
): Effect.fn.Return<ExowattHarnessAssetInventoryResult, HarnessToolError, Deps> {
  yield* requireP3Access("harness_asset_list");
  return yield* ExowattHarnessConfig.listHarnessAssets(input).pipe(
    Effect.mapError(harnessConfigError("harness_asset_list", null)),
  );
});

const harnessAssetToggle = Effect.fn("HarnessToolkit.harness_asset_toggle")(function* (
  input: ExowattHarnessAssetToggleInput,
): Effect.fn.Return<ExowattHarnessAssetInventoryResult, HarnessToolError, Deps> {
  yield* requireP3Access("harness_asset_toggle");
  return yield* ExowattHarnessConfig.toggleHarnessAsset(input).pipe(
    Effect.mapError(harnessConfigError("harness_asset_toggle", input.harness)),
  );
});

/**
 * Compare two MCP urls the way a harness config would. The join itself lives
 * in `@t3tools/shared/mcpUrl`, shared with the Customize page and the
 * auto-connect reconciler; the alias keeps this module's vocabulary.
 */
export const normalizeConnectorUrl = normalizeMcpUrl;

/** The url P3 would write for a catalog entry; `null` when its origin is unknown. */
export function resolveConnectorUrl(
  entry: ExowattConnectorCatalogEntry,
  origin: string | null,
): string | null {
  if (entry.url !== null) return entry.url;
  const trimmed = origin?.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}${EXOWATT_P3_MCP_PATH}` : null;
}

/**
 * Does this harness already point at the connector? Url first, since that is
 * what the harness actually dials; the server name is the fallback for an
 * entry a person wrote by hand against a different origin.
 */
export function connectorConfiguredIn(
  inventory: ExowattHarnessMcpInventory,
  entry: ExowattConnectorCatalogEntry,
  url: string | null,
): boolean {
  const target = normalizeConnectorUrl(url);
  return inventory.servers.some(
    (server) =>
      (target !== null && normalizeConnectorUrl(server.url) === target) ||
      server.name === entry.serverName,
  );
}

/**
 * Could `connector_add` write this connector here? A token-bearing connector
 * needs somewhere to keep the header, which the TOML harnesses do not have.
 */
export function connectorAvailableIn(
  inventory: ExowattHarnessMcpInventory,
  entry: ExowattConnectorCatalogEntry,
  url: string | null,
): boolean {
  if (!inventory.supportsAdd || url === null) return false;
  return entry.auth.kind === "none" || inventory.supportsHttpHeaders;
}

/** The `harness_mcp_add` payload for a catalog entry, header and all. */
export function connectorAddPayload(input: {
  readonly entry: ExowattConnectorCatalogEntry;
  readonly harness: ExowattHarnessId;
  readonly url: string;
  readonly token: string | undefined;
}): ExowattHarnessMcpAddInput {
  const token = input.token?.trim();
  return {
    harness: input.harness,
    name: input.entry.serverName,
    transport: "http",
    url: input.url,
    args: [],
    env: [],
    ...(token ? { headers: [{ name: "Authorization", value: `Bearer ${token}` }] } : {}),
  };
}

/**
 * Origin a coding agent on this machine can reach us on. The running server
 * records it in `server-runtime.json`; an unreadable or absent file is not an
 * error, it just means the caller has to say.
 */
const recordedServerOrigin = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
    Effect.catchCause(() => Effect.succeedNone),
  );
  return Option.isSome(state) ? state.value.origin : null;
});

const connectorList = Effect.fn("HarnessToolkit.connector_list")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattConnectorListResult, HarnessToolError, Deps> {
  yield* requireP3Access("connector_list");
  const inventory = yield* ExowattHarnessConfig.listHarnessMcpConfigs().pipe(
    Effect.mapError(harnessConfigError("connector_list", null)),
  );
  const origin = yield* recordedServerOrigin;
  return {
    connectors: EXOWATT_CONNECTOR_CATALOG.map((entry) => {
      const url = resolveConnectorUrl(entry, origin);
      return {
        connector: entry.id,
        serverName: entry.serverName,
        title: entry.title,
        description: entry.description,
        url,
        authKind: entry.auth.kind,
        needsToken: entry.auth.kind !== "none",
        configuredIn: inventory.harnesses
          .filter((harness) => connectorConfiguredIn(harness, entry, url))
          .map((harness) => harness.harness),
        availableIn: inventory.harnesses
          .filter((harness) => connectorAvailableIn(harness, entry, url))
          .map((harness) => harness.harness),
      };
    }),
  };
});

const connectorAdd = Effect.fn("HarnessToolkit.connector_add")(function* (
  input: ExowattConnectorAddInput,
): Effect.fn.Return<ExowattConnectorAddResult, HarnessToolError, Deps> {
  yield* requireP3Access("connector_add");
  const fail = (detail: string) => toolError("connector_add", input.harness, detail);
  const entry = EXOWATT_CONNECTOR_CATALOG.find((candidate) => candidate.id === input.connector);
  if (entry === undefined)
    return yield* fail(`${input.connector} is not in the connector catalog.`);

  const inventory = yield* ExowattHarnessConfig.listHarnessMcpConfigs().pipe(
    Effect.mapError(harnessConfigError("connector_add", input.harness)),
  );
  const harness = inventory.harnesses.find((candidate) => candidate.harness === input.harness);
  if (harness === undefined) return yield* fail("unknown harness.");
  if (!harness.supportsAdd) {
    return yield* fail(`P3 cannot write MCP servers into ${harness.label}'s config.`);
  }
  // Refuse before minting anything: a config with no place for the header
  // would leave an entry the agent cannot authenticate with.
  if (entry.auth.kind !== "none" && !harness.supportsHttpHeaders) {
    return yield* fail(
      `${harness.label} has nowhere to keep the token for an HTTP server, so ${entry.title} has to be added there by hand.`,
    );
  }

  if (entry.auth.kind === "user-token" && !input.token?.trim()) {
    return yield* fail(
      `${entry.title} needs a token of its own: pass \`token\` (${entry.auth.fieldLabel}).`,
    );
  }
  // Our own `/mcp` is the one connector whose credential P3 owns: the same
  // bearer session `t3 agent token` issues, labelled for Authorized Clients.
  const config = yield* ServerConfig.ServerConfig;
  const issued =
    entry.auth.kind === "p3-agent-token"
      ? yield* ExowattConnectors.issueConnectorAgentToken({
          payload: { label: input.label ?? entry.auth.tokenLabel },
          serverRuntimeStatePath: config.serverRuntimeStatePath,
        }).pipe(Effect.mapError((cause) => fail(cause.reason)))
      : null;
  const token = entry.auth.kind === "none" ? undefined : (issued?.token ?? input.token);

  const origin = input.origin ?? issued?.origin ?? (yield* recordedServerOrigin);
  const url = resolveConnectorUrl(entry, origin);
  if (url === null) {
    return yield* fail(
      "P3 does not know this server's own address yet; pass `origin`, e.g. http://127.0.0.1:3010.",
    );
  }

  const refreshed = yield* ExowattHarnessConfig.addHarnessMcpServer(
    connectorAddPayload({
      entry,
      harness: input.harness,
      url,
      token,
    }),
  ).pipe(Effect.mapError(harnessConfigError("connector_add", input.harness)));

  return {
    connector: entry.id,
    harness: input.harness,
    serverName: entry.serverName,
    url,
    tokenSessionId: issued?.sessionId ?? null,
    tokenExpiresAt: issued?.expiresAt ?? null,
    inventory: refreshed,
  };
});

/**
 * The same reconciliation the server runs at startup and every twelve hours.
 * It is the reconciler that decides whether anything needs writing, so calling
 * this on an already-connected machine costs one read per harness.
 */
const connectorReconcile = Effect.fn("HarnessToolkit.connector_reconcile")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattConnectorAutoConnectReport, HarnessToolError, Deps> {
  yield* requireP3Access("connector_reconcile");
  const autoConnect = yield* ExowattConnectorAutoConnect.ExowattConnectorAutoConnect;
  return yield* autoConnect.reconcileNow;
});

const feadsStatus = Effect.fn("HarnessToolkit.feads_status")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattFeadsStatus, HarnessToolError, Deps> {
  yield* requireP3Access("feads_status");
  const feads = yield* FeadsService.FeadsService;
  return yield* feads.status;
});

const feadsConfigure = Effect.fn("HarnessToolkit.feads_configure")(function* (
  input: ExowattFeadsConfigureInput,
): Effect.fn.Return<ExowattFeadsStatus, HarnessToolError, Deps> {
  yield* requireP3Access("feads_configure");
  const feads = yield* FeadsService.FeadsService;
  return yield* feads.configure(input).pipe(Effect.mapError(feadsError("feads_configure")));
});

const feadsClear = Effect.fn("HarnessToolkit.feads_clear")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattFeadsStatus, HarnessToolError, Deps> {
  yield* requireP3Access("feads_clear");
  const feads = yield* FeadsService.FeadsService;
  return yield* feads.clear().pipe(Effect.mapError(feadsError("feads_clear")));
});

const feadsTest = Effect.fn("HarnessToolkit.feads_test")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattFeadsTestResult, HarnessToolError, Deps> {
  yield* requireP3Access("feads_test");
  const feads = yield* FeadsService.FeadsService;
  return yield* feads.test().pipe(Effect.mapError(feadsError("feads_test")));
});

const feadsAgentwatch = Effect.fn("HarnessToolkit.feads_agentwatch")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattFeadsAgentwatchSnapshot, HarnessToolError, Deps> {
  yield* requireP3Access("feads_agentwatch");
  const bridge = yield* FeadsBridge.FeadsBridge;
  // The subscription exists to hand the UI `changes`; a tool wants the
  // snapshot and nothing else, so the scope closes with the call.
  return yield* Effect.scoped(
    Effect.map(bridge.subscribeAgentwatch, (subscription) => subscription.latest),
  );
});

const feadsMyIssues = Effect.fn("HarnessToolkit.feads_my_issues")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattFeadsMyIssuesSnapshot, HarnessToolError, Deps> {
  yield* requireP3Access("feads_my_issues");
  const bridge = yield* FeadsBridge.FeadsBridge;
  return yield* Effect.scoped(
    Effect.map(bridge.subscribeMyIssues, (subscription) => subscription.latest),
  );
});

const feadsInbox = Effect.fn("HarnessToolkit.feads_inbox")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<ExowattFeadsInboxSnapshot, HarnessToolError, Deps> {
  yield* requireP3Access("feads_inbox");
  const bridge = yield* FeadsBridge.FeadsBridge;
  return yield* Effect.scoped(
    Effect.map(bridge.subscribeInbox, (subscription) => subscription.latest),
  );
});

const feadsAck = Effect.fn("HarnessToolkit.feads_ack")(function* (
  input: ExowattFeadsAckInput,
): Effect.fn.Return<ExowattFeadsAckResult, HarnessToolError, Deps> {
  yield* requireP3Access("feads_ack");
  const bridge = yield* FeadsBridge.FeadsBridge;
  return yield* bridge.ackNotifications(input).pipe(Effect.mapError(feadsError("feads_ack")));
});

export const harnessHandlers = {
  harness_mcp_list: harnessMcpList,
  harness_mcp_add: harnessMcpAdd,
  harness_mcp_toggle: harnessMcpToggle,
  harness_mcp_status: harnessMcpStatus,
  harness_mcp_connect: harnessMcpConnect,
  harness_asset_list: harnessAssetList,
  harness_asset_toggle: harnessAssetToggle,
  connector_list: connectorList,
  connector_add: connectorAdd,
  connector_reconcile: connectorReconcile,
  feads_status: feadsStatus,
  feads_configure: feadsConfigure,
  feads_clear: feadsClear,
  feads_test: feadsTest,
  feads_agentwatch: feadsAgentwatch,
  feads_my_issues: feadsMyIssues,
  feads_inbox: feadsInbox,
  feads_ack: feadsAck,
} satisfies Parameters<typeof HarnessToolkit.toLayer>[0];

// exowatt: declared through McpToolAccess so `/mcp` registers them with an access rule.
const refuse = (tool: HarnessToolName) => () =>
  toolError(
    tool,
    null,
    `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability; harness tools need it.`,
  );

export const HarnessToolkitHandlersLive = McpToolAccess.toLayer(HarnessToolkit, {
  harness_mcp_list: McpToolAccess.usesCommandCenter(refuse("harness_mcp_list"), harnessMcpList),
  harness_mcp_add: McpToolAccess.usesCommandCenter(refuse("harness_mcp_add"), harnessMcpAdd),
  harness_mcp_toggle: McpToolAccess.usesCommandCenter(
    refuse("harness_mcp_toggle"),
    harnessMcpToggle,
  ),
  harness_mcp_status: McpToolAccess.usesCommandCenter(
    refuse("harness_mcp_status"),
    harnessMcpStatus,
  ),
  harness_mcp_connect: McpToolAccess.usesCommandCenter(
    refuse("harness_mcp_connect"),
    harnessMcpConnect,
  ),
  harness_asset_list: McpToolAccess.usesCommandCenter(
    refuse("harness_asset_list"),
    harnessAssetList,
  ),
  harness_asset_toggle: McpToolAccess.usesCommandCenter(
    refuse("harness_asset_toggle"),
    harnessAssetToggle,
  ),
  connector_list: McpToolAccess.usesCommandCenter(refuse("connector_list"), connectorList),
  connector_add: McpToolAccess.usesCommandCenter(refuse("connector_add"), connectorAdd),
  connector_reconcile: McpToolAccess.usesCommandCenter(
    refuse("connector_reconcile"),
    connectorReconcile,
  ),
  feads_status: McpToolAccess.usesCommandCenter(refuse("feads_status"), feadsStatus),
  feads_configure: McpToolAccess.usesCommandCenter(refuse("feads_configure"), feadsConfigure),
  feads_clear: McpToolAccess.usesCommandCenter(refuse("feads_clear"), feadsClear),
  feads_test: McpToolAccess.usesCommandCenter(refuse("feads_test"), feadsTest),
  feads_agentwatch: McpToolAccess.usesCommandCenter(refuse("feads_agentwatch"), feadsAgentwatch),
  feads_my_issues: McpToolAccess.usesCommandCenter(refuse("feads_my_issues"), feadsMyIssues),
  feads_inbox: McpToolAccess.usesCommandCenter(refuse("feads_inbox"), feadsInbox),
  feads_ack: McpToolAccess.usesCommandCenter(refuse("feads_ack"), feadsAck),
} satisfies McpToolAccess.Handlers<typeof HarnessToolkit.tools>);
