// Exowatt distro: helpers behind the Claude Code rows on Customize › MCP. `claude mcp list`
// also reports the account's claude.ai connectors, which the config file lacks, so the page
// adds a row for every server the status knows and the file does not.
import type {
  ExowattHarnessMcpStatusResult,
  ExowattMcpRuntimeStatus,
  ExowattMcpServer,
} from "@t3tools/contracts";

import { connectorDisplayName } from "./exowattConnectorIcon.logic";

/** Where claude.ai connectors are added, removed and re-authorized. */
export const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/customize/connectors";

export interface McpStatusBadge {
  readonly label: string;
  readonly variant: "destructive" | "info" | "warning" | "success" | "secondary";
  readonly title?: string | undefined;
}

/**
 * One badge per runtime status. Reachability comes first: a server that did
 * not answer is "unreachable" whatever its credential says, then the login
 * states Phi and Claude Code both report.
 */
export function mcpStatusBadge(status: ExowattMcpRuntimeStatus): McpStatusBadge {
  if (status.configError) {
    return { label: "misconfigured", variant: "destructive", title: status.configError };
  }
  if (status.connectionError) {
    return { label: "unreachable", variant: "destructive", title: status.connectionError };
  }
  const title = status.expiresAt ? `Expires ${status.expiresAt}` : undefined;
  if (status.loginInProgress) return { label: "login in progress", variant: "info", title };
  if (status.needsLogin) return { label: "login required", variant: "warning", title };
  if (status.credential === "valid") return { label: "connected", variant: "success", title };
  if (status.credential === "expired") {
    return { label: "credential expired", variant: "warning", title };
  }
  if (status.credential === "absent") {
    return { label: "not authenticated", variant: "secondary", title };
  }
  return { label: "no login required", variant: "info", title };
}

/**
 * Servers Claude Code reports that are in none of the config files P3 read
 * for it — the claude.ai connectors, and anything from a scope the inventory
 * does not cover. Sorted by display name, so "claude.ai Gmail" files under G.
 */
export function claudeServersOutsideInventory(input: {
  readonly inventoryServers: ReadonlyArray<ExowattMcpServer>;
  readonly statuses: ReadonlyArray<ExowattMcpRuntimeStatus>;
}): ReadonlyArray<ExowattMcpRuntimeStatus> {
  const known = new Set(input.inventoryServers.map((server) => server.name));
  return input.statuses
    .filter((status) => !known.has(status.name))
    .toSorted((left, right) =>
      connectorDisplayName(left.name).localeCompare(connectorDisplayName(right.name), undefined, {
        sensitivity: "base",
      }),
    );
}

/** "9 connected · 33 need login · 1 unreachable" for a section's status line. */
export function summarizeMcpStatuses(statuses: ReadonlyArray<ExowattMcpRuntimeStatus>): string {
  const total = statuses.length;
  if (total === 0) return "No servers reported.";
  const count = (predicate: (status: ExowattMcpRuntimeStatus) => boolean) =>
    statuses.filter(predicate).length;
  const unreachable = count((status) => Boolean(status.connectionError));
  const needLogin = count((status) => !status.connectionError && status.needsLogin);
  const connected = count(
    (status) => !status.connectionError && !status.needsLogin && status.credential === "valid",
  );
  const parts = [
    `${total} ${total === 1 ? "server" : "servers"}`,
    connected > 0 ? `${connected} connected` : null,
    needLogin > 0 ? `${needLogin} ${needLogin === 1 ? "needs" : "need"} login` : null,
    unreachable > 0 ? `${unreachable} unreachable` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/** "checked just now", "checked 2 min ago", or nothing when the harness did not say. */
export function describeCheckedAt(checkedAt: string | undefined, nowMs: number): string | null {
  if (!checkedAt) return null;
  const then = Date.parse(checkedAt);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 10) return "checked just now";
  if (seconds < 60) return `checked ${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `checked ${hours} h ago`;
}

/**
 * The one line under the Claude Code heading: what P3 is doing or what it
 * found. `undefined` status means the query has not answered yet.
 */
export function claudeRuntimeStatusLine(input: {
  readonly status: ExowattHarnessMcpStatusResult | undefined;
  readonly pending: boolean;
  readonly nowMs: number;
}): string {
  if (input.status === undefined) {
    return input.pending
      ? "Asking Claude Code about its connectors (claude mcp list health-checks every server; this can take a minute)…"
      : "Claude Code connector status has not been read yet.";
  }
  if (!input.status.available) {
    return "Claude Code did not answer: the claude command was not found, is too old for `claude mcp list`, or timed out. Only the config file is shown.";
  }
  const summary = summarizeMcpStatuses(input.status.servers);
  const checked = describeCheckedAt(input.status.checkedAt, input.nowMs);
  const refreshing = input.pending ? "refreshing…" : null;
  return [summary, checked, refreshing].filter(Boolean).join(" · ");
}

/**
 * What to tell the person after `claude mcp login` returned. Claude Code hands
 * a claude.ai connector's authorization page to the browser and exits, so
 * "connected" there means "sent you to claude.ai", not "done".
 */
export function describeClaudeLoginOutcome(result: {
  readonly connected: boolean;
  readonly error: string | null;
  readonly authorizationUrl?: string | null | undefined;
  readonly detail?: string | null | undefined;
}): { readonly kind: "notice" | "error"; readonly message: string } {
  if (!result.connected) {
    return { kind: "error", message: result.error ?? "Claude Code MCP login did not complete." };
  }
  if (result.detail || result.authorizationUrl) {
    return {
      kind: "notice",
      message:
        result.detail ??
        "Finish authorizing in the browser, then refresh; the connector is picked up by the next Claude Code session.",
    };
  }
  return { kind: "notice", message: "Login finished. Status refreshes in a moment." };
}
