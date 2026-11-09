/**
 * Connector rows for the thread Hub, merged from the thread's own MCP `dynamic_tool` items (auth
 * failures here are the urgent case), the harness config inventories with runtime status, and the
 * static connector catalog. Pure, so the merge is testable without mounting.
 */
import {
  normalizeMcpUrl,
  resolveConnectorUrl,
} from "~/components/exowatt-customize/exowattConnectors.logic";
import { resolveMcpEnablementControl } from "~/components/exowatt-customize/exowattMcp.logic";
import { parseMcpToolName } from "~/lib/hubArtifacts";
import type {
  ExowattConnectorCatalogEntry,
  ExowattConnectorId,
  ExowattHarnessId,
  ExowattHarnessMcpInventory,
  ExowattMcpRuntimeStatus,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
} from "@t3tools/contracts";

/** The harnesses whose MCP servers P3 can list, sign in to and toggle. */
export type ExowattMcpServersHarness = "phi" | "codex" | "claude";

export interface McpAuthServerRow {
  readonly name: string;
  readonly status: "connected" | "needs-auth" | "failed" | "pending" | "disabled";
  readonly detail: string | null;
  /** True when a tool of this server failed on auth mid-thread: the urgent case. */
  readonly failedInThread: boolean;
}

/** The harness a thread's provider driver is configured through, if P3 manages its MCP. */
export function hubHarnessForDriver(
  driver: ProviderDriverKind | string | null | undefined,
): ExowattMcpServersHarness | null {
  switch (driver) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "phi":
    case "pi":
      return "phi";
    default:
      return null;
  }
}

const AUTH_FAILURE =
  /\b(?:unauthori[sz]ed|unauthenticated|401|403|forbidden|sign[ -]?in|log[ -]?in|re-?authori[sz]e|authenticat(?:e|ion)|oauth|token (?:has )?expired|expired token|invalid[_ ]token|credential)/iu;

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output).slice(0, 4000);
  } catch {
    return "";
  }
}

/**
 * MCP servers this thread's tools called, from its v2 items. A server whose
 * latest call failed with an auth-shaped error needs a sign-in; one whose
 * latest call failed otherwise is "failed"; the rest connected.
 */
export function deriveThreadMcpServers(
  items: readonly OrchestrationV2TurnItem[],
): readonly McpAuthServerRow[] {
  const byKey = new Map<string, McpAuthServerRow>();
  for (const item of items) {
    if (item.type !== "dynamic_tool" || !item.toolName) continue;
    const mcp = parseMcpToolName(item.toolName);
    const server =
      mcp?.server ?? (item.toolSource?.kind === "integration" ? item.toolSource.name : null);
    if (!server) continue;
    // P3's own orchestrator server is injected into every session, not a connector.
    if (/^(?:t3[-_]?code|p3[-_]?code)$/iu.test(server)) continue;
    if (item.status !== "completed" && item.status !== "failed") continue;
    const key = hubConnectorKey(server);
    if (item.status === "completed") {
      byKey.set(key, { name: server, status: "connected", detail: null, failedInThread: false });
      continue;
    }
    const text = outputText(item.output);
    const auth = AUTH_FAILURE.test(text);
    const detail = text.trim().replace(/\s+/gu, " ").slice(0, 160) || null;
    byKey.set(key, {
      name: server,
      status: auth ? "needs-auth" : "failed",
      detail,
      failedInThread: auth,
    });
  }
  return [...byKey.values()];
}

/** The CLI the Log in button runs, for its tooltip. */
export function mcpLoginCommand(harness: ExowattMcpServersHarness, name: string): string {
  const quoted = /\s/u.test(name) ? `"${name}"` : name;
  return `${harness} mcp login ${quoted}`;
}

/**
 * Only the fields this merge reads. Structural on purpose: the caller gets
 * its statuses from an RPC query whose result type is derived from the wire
 * schema, and pinning the nominal contract type here would make the two
 * identical shapes refuse to meet.
 */
export interface HubMcpRuntimeStatus {
  readonly name: string;
  readonly enabled: boolean;
  readonly needsLogin: boolean;
  readonly configError?: string | null | undefined;
  readonly connectionError?: string | null | undefined;
}

export type HubConnectorStatus =
  | "needs-auth"
  | "failed"
  | "config-error"
  | "pending"
  | "connected"
  | "disabled"
  | "not-added";

export type HubConnectorAction =
  /** The harness's own `mcp login`, as the composer banner and Customize use. */
  | { readonly kind: "login" }
  /** Reachability failure: re-read the harness's status. */
  | { readonly kind: "reconnect" }
  /** A config P3 cannot fix from here; send the reader to Customize › MCP. */
  | { readonly kind: "manage" }
  /** Catalog entry missing from this harness. */
  | { readonly kind: "add"; readonly entry: ExowattConnectorCatalogEntry }
  /** Same, but it needs a token the person has to paste. */
  | { readonly kind: "add-token"; readonly entry: ExowattConnectorCatalogEntry }
  | { readonly kind: "none" };

export interface HubConnectorRow {
  /** Stable across renders: harness plus folded server name. */
  readonly id: string;
  readonly name: string;
  readonly harness: ExowattHarnessId;
  readonly harnessLabel: string;
  readonly status: HubConnectorStatus;
  readonly detail: string | null;
  readonly needsAttention: boolean;
  /** A tool of this server failed on auth during this thread: the urgent case. */
  readonly failedInThread: boolean;
  readonly enabled: boolean | undefined;
  readonly canToggle: boolean;
  readonly action: HubConnectorAction;
  readonly url: string | null;
  readonly connectorId: ExowattConnectorId | null;
}

export interface HubConnectorsModel {
  readonly rows: readonly HubConnectorRow[];
  readonly attention: readonly HubConnectorRow[];
  /**
   * The rows the agent actually tripped over in this thread: a tool of theirs
   * failed on auth. These are the only rows the Hub shows without being asked;
   * the rest of `attention` (signed-out connectors the session never used) is
   * folded away with everything else.
   */
  readonly urgent: readonly HubConnectorRow[];
  /**
   * Configured, working rows. Disabled servers and catalog entries that were
   * never added are their own lists so the header summary and the collapsed
   * disclosure can count one set and say the same number.
   */
  readonly healthy: readonly HubConnectorRow[];
  readonly disabled: readonly HubConnectorRow[];
  /** Catalog entries this harness does not have yet, always last. */
  readonly available: readonly HubConnectorRow[];
  readonly attentionCount: number;
  /** `healthy.length`, the number both the header and the disclosure show. */
  readonly healthyCount: number;
  /** Null until the thread's session has reported which harness it is on. */
  readonly threadHarness: ExowattMcpServersHarness | null;
}

const EMPTY_STATUSES: ReadonlyMap<string, HubMcpRuntimeStatus> = new Map();

/** Folded the way Claude Code writes tool names, matching `exowattMcpAuth`. */
export function hubConnectorKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/gu, "_").toLowerCase();
}

const ATTENTION_STATUSES: ReadonlySet<HubConnectorStatus> = new Set([
  "needs-auth",
  "failed",
  "config-error",
]);

/** Attention first (in-thread failures ahead of the rest), then healthy, then catalog. */
export function hubConnectorRank(row: HubConnectorRow): number {
  if (row.status === "needs-auth") return row.failedInThread ? 0 : 1;
  if (row.status === "config-error") return 2;
  if (row.status === "failed") return 3;
  if (row.status === "pending") return 4;
  if (row.status === "connected") return 5;
  if (row.status === "disabled") return 6;
  return 7;
}

function compareRows(left: HubConnectorRow, right: HubConnectorRow): number {
  return (
    hubConnectorRank(left) - hubConnectorRank(right) ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.harness.localeCompare(right.harness)
  );
}

function catalogEntryFor(
  catalog: readonly ExowattConnectorCatalogEntry[],
  input: {
    readonly name: string;
    readonly url: string | null;
    readonly serverOrigin: string | null;
  },
): ExowattConnectorCatalogEntry | null {
  const target = normalizeMcpUrl(input.url);
  for (const entry of catalog) {
    if (entry.serverName === input.name) return entry;
    const entryUrl = normalizeMcpUrl(resolveConnectorUrl(entry, input.serverOrigin));
    if (target !== null && entryUrl !== null && entryUrl === target) return entry;
  }
  return null;
}

function statusOf(input: {
  readonly runtimeStatus: HubMcpRuntimeStatus | undefined;
  readonly threadRow: McpAuthServerRow | undefined;
  readonly enabled: boolean | undefined;
}): { readonly status: HubConnectorStatus; readonly detail: string | null } {
  const { runtimeStatus, threadRow, enabled } = input;
  const configError = runtimeStatus?.configError ?? null;
  if (configError) return { status: "config-error", detail: configError };
  // The thread's own session outranks the config read: it is the one that
  // actually tried to call the tool.
  if (threadRow?.status === "needs-auth") {
    return { status: "needs-auth", detail: threadRow.detail };
  }
  if (threadRow?.status === "failed") return { status: "failed", detail: threadRow.detail };
  if (runtimeStatus?.needsLogin === true) {
    return { status: "needs-auth", detail: threadRow?.detail ?? "No working credential." };
  }
  const connectionError = runtimeStatus?.connectionError ?? null;
  if (connectionError) return { status: "failed", detail: connectionError };
  if (enabled === false || threadRow?.status === "disabled") {
    return { status: "disabled", detail: threadRow?.detail ?? null };
  }
  if (threadRow?.status === "pending") return { status: "pending", detail: threadRow.detail };
  return { status: "connected", detail: threadRow?.detail ?? null };
}

function actionFor(status: HubConnectorStatus): HubConnectorAction {
  switch (status) {
    case "needs-auth":
      return { kind: "login" };
    case "failed":
      return { kind: "reconnect" };
    case "config-error":
      return { kind: "manage" };
    default:
      return { kind: "none" };
  }
}

export interface HubConnectorsInput {
  /** From the thread's provider driver; null for a harness P3 does not manage. */
  readonly threadHarness: ExowattMcpServersHarness | null;
  readonly threadServers: readonly McpAuthServerRow[];
  readonly inventories: readonly ExowattHarnessMcpInventory[];
  readonly runtimeStatusesByHarness: ReadonlyMap<
    ExowattHarnessId,
    ReadonlyMap<string, HubMcpRuntimeStatus>
  >;
  /** Phi-only: whether its sidecar answered with enablement state. */
  readonly runtimeSupportsEnablement: boolean;
  readonly catalog: readonly ExowattConnectorCatalogEntry[];
  readonly serverOrigin: string | null;
}

export function buildHubConnectors(input: HubConnectorsInput): HubConnectorsModel {
  // The thread's harness when the session has said; every inventory otherwise,
  // so a thread that has not reported yet still shows something useful.
  const scoped = input.inventories.filter(
    (inventory) => input.threadHarness !== null && inventory.harness === input.threadHarness,
  );
  const inventories = scoped.length > 0 ? scoped : input.inventories;
  const threadRows = new Map(
    input.threadServers.map((row) => [hubConnectorKey(row.name), row] as const),
  );

  const rows: HubConnectorRow[] = [];
  const seenUrls = new Set<string>();
  const seenNames = new Set<string>();
  // One row per harness + folded server name: a config file that lists the
  // same server twice, or a reported name that folds onto a configured one,
  // must not be counted (or drawn) twice.
  const seenIds = new Set<string>();

  for (const inventory of inventories) {
    const statuses = input.runtimeStatusesByHarness.get(inventory.harness) ?? EMPTY_STATUSES;
    for (const server of inventory.servers) {
      const runtimeStatus = statuses.get(server.name);
      const threadRow =
        // Only the thread's own harness can speak for this thread.
        inventory.harness === input.threadHarness
          ? threadRows.get(hubConnectorKey(server.name))
          : undefined;
      const { enabled, canToggle: hasEnablementControl } = resolveMcpEnablementControl({
        harness: inventory.harness,
        rawStatus: server.status,
        runtimeStatus: runtimeStatus as ExowattMcpRuntimeStatus | undefined,
        runtimeSupportsEnablement: input.runtimeSupportsEnablement,
      });
      const { status, detail } = statusOf({ runtimeStatus, threadRow, enabled });
      const url = server.url ?? null;
      const entry = catalogEntryFor(input.catalog, {
        name: server.name,
        url,
        serverOrigin: input.serverOrigin,
      });
      const normalized = normalizeMcpUrl(url);
      if (normalized !== null) seenUrls.add(normalized);
      seenNames.add(server.name);
      const id = `${inventory.harness}:${hubConnectorKey(server.name)}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      rows.push({
        id,
        name: server.name,
        harness: inventory.harness,
        harnessLabel: inventory.label,
        status,
        detail,
        needsAttention: ATTENTION_STATUSES.has(status) || threadRow?.failedInThread === true,
        failedInThread: threadRow?.failedInThread === true,
        enabled,
        canToggle: inventory.supportsToggle && hasEnablementControl,
        action: actionFor(status),
        url,
        connectorId: entry?.id ?? null,
      });
    }
  }

  // Servers the session reported that no config file we read owns (claude.ai
  // connectors live on the account). Without these the urgent case can be missing.
  if (input.threadHarness !== null) {
    const harnessLabel =
      inventories.find((inventory) => inventory.harness === input.threadHarness)?.label ??
      input.threadHarness;
    for (const threadRow of input.threadServers) {
      if (seenNames.has(threadRow.name)) continue;
      const id = `${input.threadHarness}:${hubConnectorKey(threadRow.name)}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const status: HubConnectorStatus =
        threadRow.status === "connected" ? "connected" : threadRow.status;
      rows.push({
        id,
        name: threadRow.name,
        harness: input.threadHarness,
        harnessLabel,
        status,
        detail: threadRow.detail,
        needsAttention: ATTENTION_STATUSES.has(status) || threadRow.failedInThread,
        failedInThread: threadRow.failedInThread,
        enabled: threadRow.status !== "disabled",
        canToggle: false,
        action: actionFor(status),
        url: null,
        connectorId: null,
      });
      seenNames.add(threadRow.name);
    }
  }

  const available: HubConnectorRow[] = [];
  for (const entry of input.catalog) {
    const url = resolveConnectorUrl(entry, input.serverOrigin);
    const normalized = normalizeMcpUrl(url);
    if (seenNames.has(entry.serverName)) continue;
    if (normalized !== null && seenUrls.has(normalized)) continue;
    // A connector can only be offered where P3 can write it.
    const target = inventories.find((inventory) => inventory.supportsAdd);
    if (!target) continue;
    available.push({
      id: `catalog:${entry.id}`,
      name: entry.serverName,
      harness: target.harness,
      harnessLabel: target.label,
      status: "not-added",
      detail: entry.description,
      needsAttention: false,
      failedInThread: false,
      enabled: undefined,
      canToggle: false,
      action: entry.auth.kind === "none" ? { kind: "add", entry } : { kind: "add-token", entry },
      url,
      connectorId: entry.id,
    });
  }

  const sorted = [...rows].sort(compareRows);
  const attention = sorted.filter((row) => row.needsAttention);
  const urgent = attention.filter((row) => row.failedInThread);
  const healthy = sorted.filter((row) => !row.needsAttention && row.status !== "disabled");
  const disabled = sorted.filter((row) => !row.needsAttention && row.status === "disabled");
  const sortedAvailable = [...available].sort(compareRows);
  return {
    rows: [...sorted, ...sortedAvailable],
    attention,
    urgent,
    healthy,
    disabled,
    available: sortedAvailable,
    attentionCount: attention.length,
    healthyCount: healthy.length,
    threadHarness: input.threadHarness,
  };
}

/**
 * Header copy: what failed in this thread first, else an inventory count ("4 connected · 1
 * broken"). Signed-out servers stay out of the line (they are listed when opened). The connected
 * count is `healthyCount`, the same number the collapsed disclosure shows.
 */
export function hubConnectorsSummary(model: HubConnectorsModel): string | null {
  const urgent = model.urgent.length;
  if (urgent > 0) return `${urgent} failed in this thread`;
  const signedOut = model.attention.filter((row) => row.status === "needs-auth").length;
  const broken = model.attentionCount - signedOut;
  const parts = [
    model.healthyCount > 0 ? `${model.healthyCount} connected` : null,
    broken > 0 ? `${broken} broken` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
