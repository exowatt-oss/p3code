// Exowatt distro: the harness / connector / feads MCP toolkit, one tool per action on the
// Customize › MCP, Skills, Plugins and Extensions pages and the Settings › Sharing & access feads
// card. Inputs are those RPCs' schemas verbatim. Tool names are a wire contract; keep them
// stable. Handlers refuse anything but a human-minted `t3 agent token` session.
import {
  ExowattConnectorAddInput,
  ExowattConnectorAddResult,
  ExowattConnectorAutoConnectReport,
  ExowattConnectorListResult,
  ExowattFeadsAckInput,
  ExowattFeadsAckResult,
  ExowattFeadsAgentwatchSnapshot,
  ExowattFeadsConfigureInput,
  ExowattFeadsInboxSnapshot,
  ExowattFeadsMyIssuesSnapshot,
  ExowattFeadsStatus,
  ExowattFeadsTestResult,
  ExowattHarnessAssetInventoryResult,
  ExowattHarnessAssetListInput,
  ExowattHarnessAssetToggleInput,
  ExowattHarnessMcpAddInput,
  ExowattHarnessMcpConnectInput,
  ExowattHarnessMcpConnectResult,
  ExowattHarnessMcpInventoryResult,
  ExowattHarnessMcpStatusInput,
  ExowattHarnessMcpStatusResult,
  ExowattHarnessMcpToggleInput,
  ExowattHarnessMcpToggleResult,
  HarnessToolError,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";
import { ChildProcessSpawner } from "effect/process";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../../config.ts";
import * as ExowattConnectorAutoConnect from "../../../exowattConnectorAutoConnect.ts";
import * as FeadsBridge from "../../../feads/FeadsBridge.ts";
import * as FeadsService from "../../../feads/FeadsService.ts";
import * as HarnessLaunchEnvironment from "../../../provider/HarnessLaunchEnvironment.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * The union every handler runs in. Reading a harness config needs the login
 * shell environment, the Phi control CLI needs a spawner, and minting a
 * connector token needs the environment auth store and the runtime state file;
 * declaring them once keeps the toolkit layer's requirements honest.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ExowattConnectorAutoConnect.ExowattConnectorAutoConnect,
  HarnessLaunchEnvironment.HarnessLaunchEnvironment,
  ChildProcessSpawner.ChildProcessSpawner,
  FileSystem.FileSystem,
  EnvironmentAuth.EnvironmentAuth,
  ServerConfig.ServerConfig,
  ServerSettings.ServerSettingsService,
  FeadsService.FeadsService,
  FeadsBridge.FeadsBridge,
];

export const HarnessMcpListTool = Tool.make("harness_mcp_list", {
  description:
    "Inventory the MCP servers configured in every coding harness on this machine (phi, codex, claude, cursor, grok, opencode): the config files read, each server's transport, command or url, env var names, and whether it is enabled. Also says which harnesses P3 can write to and which can hold an Authorization header. Read-only.",
  parameters: Tool.EmptyParams,
  success: ExowattHarnessMcpInventoryResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "List harness MCP servers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HarnessMcpAddTool = Tool.make("harness_mcp_add", {
  description:
    "Add an MCP server to one harness's config file, stdio (`command` plus `args` and `env`) or http (`url` plus `headers`). Rewrites the harness's own config format in place and returns the refreshed inventory. Fails when the harness cannot hold what was asked for, or already has a server under that name.",
  parameters: ExowattHarnessMcpAddInput,
  success: ExowattHarnessMcpInventoryResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Add harness MCP server")
  .annotate(Tool.Destructive, false);

export const HarnessMcpToggleTool = Tool.make("harness_mcp_toggle", {
  description:
    "Enable or disable one MCP server in a harness. Phi is toggled through its own control CLI, the other harnesses by editing their config; harnesses with no stable enable/disable setting refuse. `inventory` is the refreshed config inventory, and is null for Phi, which owns effective state itself; read it back with harness_mcp_status.",
  parameters: ExowattHarnessMcpToggleInput,
  success: ExowattHarnessMcpToggleResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Toggle harness MCP server")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HarnessMcpStatusTool = Tool.make("harness_mcp_status", {
  description:
    "A harness's runtime view of its MCP servers. Phi: whether each is enabled, its credential state (valid, expired, absent), whether it needs an OAuth login, a login already running, and any config error that made Phi drop the server at load time. Claude Code: every server `claude mcp list` health-checks, including the claude.ai connectors (Gmail, Slack, Drive, …) that live in the person's claude.ai account and appear in no config file, marked `managedBy: \"claude.ai\"`, with `connectionError` when a server was unreachable; that answer is cached for about 90 seconds unless `refresh` is set. Codex: every server in its config with its `codex mcp list --json` auth state (`needsLogin` for an OAuth server without a credential); no health check. `available: false` means the harness has no such CLI, or is none of Phi, Claude Code and Codex. Read-only.",
  parameters: ExowattHarnessMcpStatusInput,
  success: ExowattHarnessMcpStatusResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get harness MCP runtime status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HarnessMcpConnectTool = Tool.make("harness_mcp_connect", {
  description:
    "Run the harness's OAuth login for one MCP server so it has a working credential. Phi, Claude Code and Codex support it (`phi mcp login`, `claude mcp login`, `codex mcp login`); other harnesses return `connected: false` with no error. Long-running: it opens a browser on the server's machine and waits for the person to finish, up to 10 minutes, and returns `connected: false` with the reason if it does not complete. For a claude.ai connector Claude Code hands the authorization page to the browser and returns at once with `authorizationUrl` and a `detail` sentence; the connector is picked up by the next Claude Code session. A thread whose session already saw the server fail needs a fresh session to use the new credential.",
  parameters: ExowattHarnessMcpConnectInput,
  success: ExowattHarnessMcpConnectResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Connect harness MCP server")
  .annotate(Tool.Destructive, false);

export const HarnessAssetListTool = Tool.make("harness_asset_list", {
  description:
    "Inventory one kind of harness add-on across every harness: `skills`, `plugins`, or `extensions`. Returns each item's name, whether it is enabled, the file or directory it came from, and whether P3 can toggle it there. Read-only.",
  parameters: ExowattHarnessAssetListInput,
  success: ExowattHarnessAssetInventoryResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "List harness skills, plugins or extensions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HarnessAssetToggleTool = Tool.make("harness_asset_toggle", {
  description:
    "Enable or disable one skill, plugin, or extension in a harness, by the `name` and `sourcePath` harness_asset_list reported. Returns the refreshed inventory. Harnesses that expose no stable toggle for that kind refuse.",
  parameters: ExowattHarnessAssetToggleInput,
  success: ExowattHarnessAssetInventoryResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Toggle harness skill, plugin or extension")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ConnectorListTool = Tool.make("connector_list", {
  description:
    "The Exowatt MCP connector catalog P3 offers (this P3 server itself, feads, team activity), with the url P3 would write, whether it needs a token, which harnesses already have it configured, and which ones connector_add would accept. Read-only.",
  parameters: Tool.EmptyParams,
  success: ExowattConnectorListResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Exowatt connectors")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ConnectorAddTool = Tool.make("connector_add", {
  description:
    'Write a catalog connector into a harness, the way the Customize › MCP "Add to" button does. For this P3 server it mints an agent token first and writes an http entry with the Authorization header; for a connector whose token the person holds, pass `token`; a connector with no credential just gets its url. Refuses a harness P3 cannot write to, or whose config format could not carry the header a token-bearing connector needs.',
  parameters: ExowattConnectorAddInput,
  success: ExowattConnectorAddResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Add an Exowatt connector to a harness")
  .annotate(Tool.Destructive, false);

export const ConnectorReconcileTool = Tool.make("connector_reconcile", {
  description:
    "Run the auto-connect reconciliation now: for every harness installed on this machine, make sure its config has a `p3` MCP entry pointing at this server's `/mcp` with a token that is still valid, minting and rotating as needed. Returns one row per harness saying what happened (`added`, `moved`, `rotated`, `unchanged`, `skipped`, `failed`). Idempotent: a machine that is already connected is not rewritten. Does nothing when the `exowattAutoConnectHarnesses` setting is off, on a dev server, or before this server has recorded its own origin.",
  parameters: Tool.EmptyParams,
  success: ExowattConnectorAutoConnectReport,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Reconnect the installed harnesses to P3")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const FeadsStatusTool = Tool.make("feads_status", {
  description:
    "Whether this P3 server is wired to feads: the base url, the actor its token resolves to, the default board, when it last reached feads, the last error, where the token came from (`environment` means P3_FEADS_TOKEN is set on the server and cannot be changed from here), and `presence`: whether this server publishes Agentwatch presence for its non-Phi threads (Phi publishes its own), how many rows feads holds, when it last accepted one, and the last failure. Never returns the token. Read-only.",
  parameters: Tool.EmptyParams,
  success: ExowattFeadsStatus,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get feads integration status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const FeadsConfigureTool = Tool.make("feads_configure", {
  description:
    "Point this P3 server at feads: store an agent token, and optionally a base url and default board. The token is write-only: it goes to the server's secret store and no tool ever reads it back. Pass only the fields to change; omitting `token` keeps the stored one.",
  parameters: ExowattFeadsConfigureInput,
  success: ExowattFeadsStatus,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Configure the feads integration")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const FeadsClearTool = Tool.make("feads_clear", {
  description:
    "Forget the stored feads configuration: the token, base url, and default board. The Agentwatch, My board, and inbox feeds go quiet until feads_configure runs again. A token set through P3_FEADS_TOKEN on the server is unaffected.",
  parameters: Tool.EmptyParams,
  success: ExowattFeadsStatus,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Clear the feads configuration")
  .annotate(Tool.Idempotent, true);

export const FeadsTestTool = Tool.make("feads_test", {
  description:
    "Check the stored feads credential against feads right now and report the actor it resolved to, or a stable failure code (`not_configured`, `not_identified`, `http_503`, `network`). Read-only.",
  parameters: Tool.EmptyParams,
  success: ExowattFeadsTestResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Test the feads credential")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const FeadsAgentwatchTool = Tool.make("feads_agentwatch", {
  description:
    "The latest Agentwatch snapshot the server holds: who is working on the board, what they hold, their runtime sessions, and the shared discussions. `available: false` means feads does not serve this route for the current token. Read-only, and served from the poller's last good result rather than a fresh fetch.",
  parameters: Tool.EmptyParams,
  success: ExowattFeadsAgentwatchSnapshot,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read the feads Agentwatch snapshot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const FeadsMyIssuesTool = Tool.make("feads_my_issues", {
  description:
    "The latest snapshot of the beads assigned to the actor this server's feads token resolves to, with status, board, priority, labels, and what blocks each one. Read-only, and served from the poller's last good result. Read-only.",
  parameters: Tool.EmptyParams,
  success: ExowattFeadsMyIssuesSnapshot,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read my feads issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const FeadsInboxTool = Tool.make("feads_inbox", {
  description:
    "The latest feads notification inbox snapshot for this server's actor (mentions, assignments, comments on owned beads), with the unread count and a dashboard link per row. Read-only, and served from the poller's last good result.",
  parameters: Tool.EmptyParams,
  success: ExowattFeadsInboxSnapshot,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read the feads inbox")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const FeadsAckTool = Tool.make("feads_ack", {
  description:
    "Acknowledge feads notifications: pass `ids` from feads_inbox, or `all: true` for every unread row. Only acknowledge what has actually been handled.",
  parameters: ExowattFeadsAckInput,
  success: ExowattFeadsAckResult,
  failure: HarnessToolError,
  dependencies,
})
  .annotate(Tool.Title, "Acknowledge feads notifications")
  .annotate(Tool.Destructive, false);

export const HarnessToolkit = Toolkit.make(
  HarnessMcpListTool,
  HarnessMcpAddTool,
  HarnessMcpToggleTool,
  HarnessMcpStatusTool,
  HarnessMcpConnectTool,
  HarnessAssetListTool,
  HarnessAssetToggleTool,
  ConnectorListTool,
  ConnectorAddTool,
  ConnectorReconcileTool,
  FeadsStatusTool,
  FeadsConfigureTool,
  FeadsClearTool,
  FeadsTestTool,
  FeadsAgentwatchTool,
  FeadsMyIssuesTool,
  FeadsInboxTool,
  FeadsAckTool,
);
