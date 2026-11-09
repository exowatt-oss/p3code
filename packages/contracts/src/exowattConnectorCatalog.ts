/**
 * Exowatt distro: the static MCP connector catalog in Customize › MCP. Plain data, the same for
 * every install, so the client renders it without a round trip; add an entry by appending to
 * `EXOWATT_CONNECTOR_CATALOG`. Only the server origin and the minted token come from the server.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExowattHarnessId } from "./exowattHarnessConfig.ts";

export const ExowattConnectorId = Schema.Literals(["p3", "feads", "team-activity", "fluxbots"]);
export type ExowattConnectorId = typeof ExowattConnectorId.Type;

/**
 * How a connector proves who it is: `none` (no credential in v1), `p3-agent-token` (P3 mints the
 * same bearer session `t3 agent token` issues, labelled for Authorized Clients) or `user-token`
 * (pasted by the person, never stored by P3, written straight into the harness entry).
 */
export type ExowattConnectorAuth =
  | { readonly kind: "none" }
  | { readonly kind: "p3-agent-token"; readonly tokenLabel: string }
  | {
      readonly kind: "user-token";
      readonly fieldLabel: string;
      readonly placeholder: string;
      readonly help: string;
    };

export interface ExowattConnectorCatalogEntry {
  readonly id: ExowattConnectorId;
  /** Name written into the harness config, and how the harness will show it. */
  readonly serverName: string;
  /** Human title in the catalog row. */
  readonly title: string;
  /** One line, no marketing. */
  readonly description: string;
  /**
   * Absolute URL, or `null` when it is this P3 server's own `/mcp` and has to
   * be resolved from the running server's origin.
   */
  readonly url: string | null;
  readonly auth: ExowattConnectorAuth;
}

export const EXOWATT_CONNECTOR_CATALOG: ReadonlyArray<ExowattConnectorCatalogEntry> = [
  {
    id: "p3",
    serverName: "p3",
    title: "P3 Code",
    description: "Let a coding agent drive P3: threads, transcripts, summaries.",
    url: null,
    auth: { kind: "p3-agent-token", tokenLabel: "coding-agent" },
  },
];

/** Path this server serves its own MCP endpoint on. */
export const EXOWATT_P3_MCP_PATH = "/mcp";

export const ExowattConnectorIssueAgentTokenInput = Schema.Struct({
  /** Shown in Settings › Authorized Clients, e.g. `claude-code`. */
  label: TrimmedNonEmptyString,
});
export type ExowattConnectorIssueAgentTokenInput = typeof ExowattConnectorIssueAgentTokenInput.Type;

export const ExowattConnectorIssueAgentTokenResult = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
  label: Schema.String,
  /** ISO instant the session expires. */
  expiresAt: Schema.String,
  /**
   * Origin recorded in `server-runtime.json`, or `null` when no running server
   * wrote one; the client then falls back to the origin it is connected to.
   */
  origin: Schema.NullOr(Schema.String),
});
export type ExowattConnectorIssueAgentTokenResult =
  typeof ExowattConnectorIssueAgentTokenResult.Type;

export class ExowattConnectorError extends Schema.TaggedError<ExowattConnectorError>()(
  "ExowattConnectorError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * What the auto-connect reconciler did to one harness: `added` a `p3` entry, `moved` it to this
 * server's origin, `rotated` a missing/revoked/expiring token, left it `unchanged`, `skipped` it
 * (not installed, or auto-connect off), or `failed` to read or write its config.
 */
export const ExowattConnectorAutoConnectAction = Schema.Literals([
  "added",
  "moved",
  "rotated",
  "unchanged",
  "skipped",
  "failed",
]);
export type ExowattConnectorAutoConnectAction = typeof ExowattConnectorAutoConnectAction.Type;

export const ExowattConnectorAutoConnectHarnessResult = Schema.Struct({
  harness: ExowattHarnessId,
  action: ExowattConnectorAutoConnectAction,
  /** One sentence for a log line or the Customize row; never a token. */
  detail: Schema.String,
});
export type ExowattConnectorAutoConnectHarnessResult =
  typeof ExowattConnectorAutoConnectHarnessResult.Type;

export const ExowattConnectorAutoConnectReport = Schema.Struct({
  /** The `exowattAutoConnectHarnesses` setting as the run saw it. */
  enabled: Schema.Boolean,
  /**
   * Origin the run wrote, from `server-runtime.json`. `null` when no running
   * server had recorded one yet, which is a skip for every harness.
   */
  origin: Schema.NullOr(Schema.String),
  harnesses: Schema.Array(ExowattConnectorAutoConnectHarnessResult),
});
export type ExowattConnectorAutoConnectReport = typeof ExowattConnectorAutoConnectReport.Type;

/** Label and subject of the session P3 mints for one harness. */
export function exowattAutoConnectTokenLabel(harness: string): string {
  return `p3-auto:${harness}`;
}

/** How close to expiry a token gets rotated rather than left in place. */
export const EXOWATT_AUTO_CONNECT_ROTATE_WITHIN_DAYS = 7;
