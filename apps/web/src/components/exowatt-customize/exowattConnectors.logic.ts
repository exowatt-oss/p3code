import {
  EXOWATT_P3_MCP_PATH,
  type ExowattConnectorAutoConnectReport,
  type ExowattConnectorCatalogEntry,
  type ExowattHarnessId,
  type ExowattHarnessMcpAddInput,
  type ExowattHarnessMcpInventory,
} from "@t3tools/contracts";
import { normalizeMcpUrl } from "@t3tools/shared/mcpUrl";

// The Customize page, the connector MCP tools and the server's auto-connect
// reconciler all have to answer "is this the same MCP server?", so the compare
// lives in `@t3tools/shared/mcpUrl` and is re-exported here for this page.
export { normalizeMcpUrl };

/**
 * The URL P3 would write for this connector. `p3` is this server's own `/mcp`,
 * so it needs the origin the client is talking to (or the one the server
 * recorded in `server-runtime.json`, once a token has been minted).
 */
export function resolveConnectorUrl(
  entry: ExowattConnectorCatalogEntry,
  serverOrigin: string | null,
): string | null {
  if (entry.url !== null) return entry.url;
  const origin = serverOrigin?.trim().replace(/\/+$/, "");
  return origin ? `${origin}${EXOWATT_P3_MCP_PATH}` : null;
}

export function connectorNeedsToken(entry: ExowattConnectorCatalogEntry): boolean {
  return entry.auth.kind !== "none";
}

export function isConnectorInInventory(
  inventory: ExowattHarnessMcpInventory,
  url: string | null,
): boolean {
  const target = normalizeMcpUrl(url);
  if (target === null) return false;
  return inventory.servers.some((server) => normalizeMcpUrl(server.url) === target);
}

export type ExowattConnectorHarnessState =
  | { readonly kind: "add" }
  | { readonly kind: "added" }
  /** `reason` is a bare phrase; `connectorUnavailableSummary` supplies the subject. */
  | { readonly kind: "unavailable"; readonly reason: string };

export const CONNECTOR_NO_HEADER_REASON =
  "nowhere to keep the token for an HTTP server, so add it there by hand";
export const CONNECTOR_NO_ORIGIN_REASON = "P3 does not know this server's own address yet";

export interface ExowattConnectorHarnessAction {
  readonly harness: ExowattHarnessId;
  readonly label: string;
  readonly state: ExowattConnectorHarnessState;
}

/**
 * One row of buttons per harness that can be written to. A harness that cannot
 * hold the connector says so instead of offering a button that would leave a
 * config the agent cannot authenticate with.
 */
export function connectorHarnessActions(input: {
  readonly entry: ExowattConnectorCatalogEntry;
  readonly url: string | null;
  readonly inventories: ReadonlyArray<ExowattHarnessMcpInventory>;
}): ReadonlyArray<ExowattConnectorHarnessAction> {
  return input.inventories
    .filter((inventory) => inventory.supportsAdd)
    .map((inventory): ExowattConnectorHarnessAction => {
      const base = { harness: inventory.harness, label: inventory.label };
      if (input.url === null) {
        return {
          ...base,
          state: { kind: "unavailable", reason: CONNECTOR_NO_ORIGIN_REASON },
        };
      }
      if (isConnectorInInventory(inventory, input.url)) {
        return { ...base, state: { kind: "added" } };
      }
      if (connectorNeedsToken(input.entry) && !inventory.supportsHttpHeaders) {
        return { ...base, state: { kind: "unavailable", reason: CONNECTOR_NO_HEADER_REASON } };
      }
      return { ...base, state: { kind: "add" } };
    });
}

/**
 * One sentence naming every harness that cannot take this connector, grouped
 * by why — so two blocked harnesses do not turn into one harness's excuse.
 */
export function connectorUnavailableSummary(
  actions: ReadonlyArray<ExowattConnectorHarnessAction>,
): string | null {
  const byReason = new Map<string, Array<string>>();
  for (const action of actions) {
    if (action.state.kind !== "unavailable") continue;
    const labels = byReason.get(action.state.reason);
    if (labels) labels.push(action.label);
    else byReason.set(action.state.reason, [action.label]);
  }
  if (byReason.size === 0) return null;
  return [...byReason.entries()]
    .map(([reason, labels]) => `${labels.join(", ")}: ${reason}.`)
    .join(" ");
}

/** The `harnessMcp.add` payload for a catalog entry. */
export function buildConnectorAddInput(input: {
  readonly entry: ExowattConnectorCatalogEntry;
  readonly harness: ExowattHarnessId;
  readonly url: string;
  /** Bearer token, when the connector needs one. */
  readonly token?: string | undefined;
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
 * Prefer the origin the running server recorded over the one the browser is
 * connected to: a relay or dev URL reaches P3 too, but a coding agent on the
 * same machine has to use the server's own address.
 */
export function preferredServerOrigin(input: {
  readonly issuedOrigin: string | null;
  readonly clientOrigin: string | null;
}): string | null {
  return input.issuedOrigin?.trim() || input.clientOrigin?.trim() || null;
}

/**
 * One line for the auto-connect switch's status: what the last run did, by
 * harness. A run where every harness was skipped has one reason for all of
 * them (off, dev server, no origin yet), so it says that instead.
 */
export function summarizeAutoConnectReport(input: {
  readonly report: ExowattConnectorAutoConnectReport;
  readonly inventories: ReadonlyArray<ExowattHarnessMcpInventory>;
}): string {
  const labels = new Map(
    input.inventories.map((inventory) => [inventory.harness, inventory.label]),
  );
  const named = (actions: ReadonlyArray<string>) =>
    input.report.harnesses
      .filter((harness) => actions.includes(harness.action))
      .map((harness) => labels.get(harness.harness) ?? harness.harness);

  const rows = input.report.harnesses;
  if (rows.length === 0) return "Nothing to reconnect.";
  if (rows.every((harness) => harness.action === "skipped")) {
    return rows[0]?.detail ?? "Nothing to reconnect.";
  }

  const phrases = [
    ["Connected", named(["added"])],
    ["Reconnected", named(["moved", "rotated"])],
    ["Already connected", named(["unchanged"])],
    ["Could not write", named(["failed"])],
  ] as const;
  const sentences = phrases
    .filter(([, harnesses]) => harnesses.length > 0)
    .map(([verb, harnesses]) => `${verb}: ${harnesses.join(", ")}.`);
  return sentences.length > 0 ? sentences.join(" ") : "Nothing to reconnect.";
}
