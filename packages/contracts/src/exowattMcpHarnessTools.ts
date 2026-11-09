// Exowatt distro: MCP tool contracts for the harness, connector and feads toolkit (what the Customize
// pages and the feads card do), reusing the WebSocket RPC schemas. They reconfigure harnesses and
// mint credentials, so only a human-minted `t3 agent token` session may call them; an in-app
// provider session gets `HarnessToolError`.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExowattConnectorId } from "./exowattConnectorCatalog.ts";
import { ExowattHarnessId, ExowattHarnessMcpInventoryResult } from "./exowattHarnessConfig.ts";

/**
 * How a connector proves who it is, flattened for the wire. `p3-agent-token`
 * means P3 mints the credential itself when the connector is added; a
 * `user-token` connector needs the caller to pass `token`.
 */
export const ExowattConnectorAuthKind = Schema.Literals(["none", "p3-agent-token", "user-token"]);
export type ExowattConnectorAuthKind = typeof ExowattConnectorAuthKind.Type;

/** One catalog connector, with the harnesses that already carry it. */
export const ExowattConnectorInventoryEntry = Schema.Struct({
  connector: ExowattConnectorId,
  /** Name written into the harness config, and how the harness will show it. */
  serverName: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  /**
   * Absolute URL P3 would write, or `null` when it is this server's own `/mcp`
   * and no origin is known yet — pass `origin` to `connector_add` then.
   */
  url: Schema.NullOr(Schema.String),
  authKind: ExowattConnectorAuthKind,
  /** True when the harness entry has to carry a credential header. */
  needsToken: Schema.Boolean,
  /** Harnesses whose config already points at this connector. */
  configuredIn: Schema.Array(ExowattHarnessId),
  /** Harnesses `connector_add` would accept for this connector today. */
  availableIn: Schema.Array(ExowattHarnessId),
});
export type ExowattConnectorInventoryEntry = typeof ExowattConnectorInventoryEntry.Type;

export const ExowattConnectorListResult = Schema.Struct({
  connectors: Schema.Array(ExowattConnectorInventoryEntry),
});
export type ExowattConnectorListResult = typeof ExowattConnectorListResult.Type;

export const ExowattConnectorAddInput = Schema.Struct({
  connector: ExowattConnectorId.annotate({
    description: "Catalog connector to write, from connector_list.",
  }),
  harness: ExowattHarnessId.annotate({
    description: "Harness config to write it into.",
  }),
  token: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Bearer token for a `user-token` connector, e.g. a feads agent token. Written into the harness config as an Authorization header and not stored by P3. Ignored for other connectors.",
    }),
  ),
  label: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "For `p3-agent-token` connectors: label the minted session is listed under in Settings › Authorized Clients. Defaults to the catalog's label.",
    }),
  ),
  origin: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Origin to reach this P3 server on, e.g. `http://127.0.0.1:3010`. Only used for connectors served by this server, and only when it has not recorded its own origin yet.",
    }),
  ),
});
export type ExowattConnectorAddInput = typeof ExowattConnectorAddInput.Type;

export const ExowattConnectorAddResult = Schema.Struct({
  connector: ExowattConnectorId,
  harness: ExowattHarnessId,
  serverName: TrimmedNonEmptyString,
  /** URL written into the harness config. */
  url: Schema.String,
  /**
   * Session P3 minted for this entry, `null` when the connector needed no
   * credential of ours. Revoke it with `t3 auth session revoke <id>`.
   */
  tokenSessionId: Schema.NullOr(Schema.String),
  /** ISO instant the minted session expires; `null` when none was minted. */
  tokenExpiresAt: Schema.NullOr(Schema.String),
  /** Refreshed inventory, so the caller sees the entry it just wrote. */
  inventory: ExowattHarnessMcpInventoryResult,
});
export type ExowattConnectorAddResult = typeof ExowattConnectorAddResult.Type;

export const HarnessToolName = Schema.Literals([
  "harness_mcp_list",
  "harness_mcp_add",
  "harness_mcp_toggle",
  "harness_mcp_status",
  "harness_mcp_connect",
  "harness_asset_list",
  "harness_asset_toggle",
  "connector_list",
  "connector_add",
  "connector_reconcile",
  "feads_status",
  "feads_configure",
  "feads_clear",
  "feads_test",
  "feads_agentwatch",
  "feads_my_issues",
  "feads_inbox",
  "feads_ack",
]);
export type HarnessToolName = typeof HarnessToolName.Type;

export class HarnessToolError extends Schema.TaggedError<HarnessToolError>()("HarnessToolError", {
  tool: HarnessToolName,
  harness: Schema.NullOr(ExowattHarnessId),
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.tool} failed${this.harness ? ` for ${this.harness}` : ""}: ${this.detail}`;
  }
}
