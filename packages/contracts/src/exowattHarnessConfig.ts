import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExowattHarnessId = Schema.Literals([
  "phi",
  "codex",
  "claude",
  "cursor",
  "grok",
  "opencode",
]);
export type ExowattHarnessId = typeof ExowattHarnessId.Type;

export const ExowattHarnessItemStatus = Schema.Literals(["enabled", "disabled"]);
export type ExowattHarnessItemStatus = typeof ExowattHarnessItemStatus.Type;

export const ExowattMcpTransport = Schema.Literals(["stdio", "http"]);
export type ExowattMcpTransport = typeof ExowattMcpTransport.Type;

export const ExowattMcpServer = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: ExowattHarnessItemStatus,
  sourcePath: TrimmedNonEmptyString,
  transport: ExowattMcpTransport,
  command: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  args: Schema.Array(Schema.String),
  envNames: Schema.Array(Schema.String),
});
export type ExowattMcpServer = typeof ExowattMcpServer.Type;

export const ExowattHarnessMcpInventory = Schema.Struct({
  harness: ExowattHarnessId,
  label: TrimmedNonEmptyString,
  rootPath: TrimmedNonEmptyString,
  sourcePaths: Schema.Array(Schema.String),
  supportsToggle: Schema.Boolean,
  supportsAdd: Schema.Boolean,
  /**
   * Whether an HTTP server written here can carry a credential (JSON `headers`, Codex
   * `http_headers`, Grok `headers`). A client that sees `false` (an older server, or a format with
   * nowhere to put one) must not offer to add a connector that needs a token.
   */
  supportsHttpHeaders: Schema.Boolean,
  servers: Schema.Array(ExowattMcpServer),
  warnings: Schema.Array(Schema.String),
});
export type ExowattHarnessMcpInventory = typeof ExowattHarnessMcpInventory.Type;

export const ExowattHarnessMcpInventoryResult = Schema.Struct({
  harnesses: Schema.Array(ExowattHarnessMcpInventory),
});
export type ExowattHarnessMcpInventoryResult = typeof ExowattHarnessMcpInventoryResult.Type;

export const ExowattHarnessMcpListInput = Schema.Struct({});
export type ExowattHarnessMcpListInput = typeof ExowattHarnessMcpListInput.Type;

export const ExowattMcpEnvironmentVariable = Schema.Struct({
  name: TrimmedNonEmptyString,
  value: Schema.String,
});
export type ExowattMcpEnvironmentVariable = typeof ExowattMcpEnvironmentVariable.Type;

export const ExowattMcpHeader = Schema.Struct({
  name: TrimmedNonEmptyString,
  value: Schema.String,
});
export type ExowattMcpHeader = typeof ExowattMcpHeader.Type;

export const ExowattHarnessMcpAddInput = Schema.Struct({
  harness: ExowattHarnessId,
  name: TrimmedNonEmptyString,
  transport: ExowattMcpTransport,
  command: Schema.optionalKey(TrimmedNonEmptyString),
  url: Schema.optionalKey(TrimmedNonEmptyString),
  args: Schema.Array(Schema.String),
  env: Schema.Array(ExowattMcpEnvironmentVariable),
  /** HTTP-transport only; ignored for stdio, which uses `env` instead. */
  headers: Schema.optionalKey(Schema.Array(ExowattMcpHeader)),
});
export type ExowattHarnessMcpAddInput = typeof ExowattHarnessMcpAddInput.Type;

export const ExowattHarnessMcpToggleInput = Schema.Struct({
  harness: ExowattHarnessId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ExowattHarnessMcpToggleInput = typeof ExowattHarnessMcpToggleInput.Type;

export const ExowattHarnessMcpToggleResult = Schema.Struct({
  harness: ExowattHarnessId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  /** Raw-config harnesses return refreshed inventory; Phi owns effective state externally. */
  inventory: Schema.NullOr(ExowattHarnessMcpInventoryResult),
});
export type ExowattHarnessMcpToggleResult = typeof ExowattHarnessMcpToggleResult.Type;

/** Who owns a server's configuration when it is not a file on this machine. */
export const ExowattMcpManagedBy = Schema.Literals(["claude.ai"]);
export type ExowattMcpManagedBy = typeof ExowattMcpManagedBy.Type;

export const ExowattMcpRuntimeStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: ExowattMcpTransport,
  enabled: Schema.Boolean,
  authMode: Schema.Literals(["oauth", "none", "static"]),
  credential: Schema.Literals(["valid", "expired", "absent", "n/a"]),
  expiresAt: Schema.optionalKey(Schema.String),
  needsLogin: Schema.Boolean,
  loginInProgress: Schema.Boolean,
  // Added in phi 0.83.0-exo.34; optional so older phi builds still decode.
  // A non-null configError means phi dropped the server at load time (parse or
  // unresolved ${VAR}); it says nothing about the remote. Names only, never values.
  configError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  missingEnv: Schema.optionalKey(Schema.Array(Schema.String)),
  // Added with Claude Code status (`claude mcp list`), optional so Phi's
  // envelope still decodes.
  /** The url (http) or command line (stdio) the harness reported for this server. */
  target: Schema.optionalKey(Schema.String),
  /**
   * Set when the server is not in any config file P3 reads: `claude.ai`
   * connectors are attached to the person's claude.ai account and Claude Code
   * learns about them at startup. Such a server has no `sourcePath` to open.
   */
  managedBy: Schema.optionalKey(ExowattMcpManagedBy),
  /**
   * The harness health-checked the server and could not reach it (an HTTP 502,
   * a dead stdio command). Says nothing about credentials: `needsLogin` is the
   * authentication question, this is the reachability one.
   */
  connectionError: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ExowattMcpRuntimeStatus = typeof ExowattMcpRuntimeStatus.Type;

export const ExowattHarnessMcpStatusInput = Schema.Struct({
  harness: ExowattHarnessId,
  /**
   * Ask the harness again even if a recent answer is cached. Only Claude Code
   * caches (its `claude mcp list` health-checks every server); Phi answers
   * from its sidecar in milliseconds and ignores this.
   */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type ExowattHarnessMcpStatusInput = typeof ExowattHarnessMcpStatusInput.Type;

export const ExowattHarnessMcpStatusResult = Schema.Struct({
  available: Schema.Boolean,
  /** True only when the installed Phi advertises the sidecar-backed control CLI. */
  supportsEnablement: Schema.optionalKey(Schema.Boolean),
  servers: Schema.Array(ExowattMcpRuntimeStatus),
  /**
   * ISO instant the harness was asked. Claude Code health-checks every server
   * on `claude mcp list`, which takes a minute or more for a long list, so P3
   * keeps the last answer for a short while and says how old it is.
   */
  checkedAt: Schema.optionalKey(Schema.String),
});
export type ExowattHarnessMcpStatusResult = typeof ExowattHarnessMcpStatusResult.Type;

export const ExowattHarnessMcpConnectInput = Schema.Struct({
  harness: ExowattHarnessId,
  name: TrimmedNonEmptyString,
});
export type ExowattHarnessMcpConnectInput = typeof ExowattHarnessMcpConnectInput.Type;

export const ExowattHarnessMcpConnectResult = Schema.Struct({
  connected: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  /**
   * The authorization page the harness printed, if any. Claude Code exits once it has handed a
   * claude.ai connector page to the browser, so the client shows the link in case the browser did
   * not come to the front (or is on another machine, for an SSH environment).
   */
  authorizationUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** One sentence from the harness about what happens next, e.g. that the connector is picked up by the next Claude Code session. */
  detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ExowattHarnessMcpConnectResult = typeof ExowattHarnessMcpConnectResult.Type;

export const ExowattHarnessAssetKind = Schema.Literals(["skills", "plugins", "extensions"]);
export type ExowattHarnessAssetKind = typeof ExowattHarnessAssetKind.Type;

export const ExowattHarnessAsset = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: ExowattHarnessItemStatus,
  sourcePath: TrimmedNonEmptyString,
});
export type ExowattHarnessAsset = typeof ExowattHarnessAsset.Type;

export const ExowattHarnessAssetInventory = Schema.Struct({
  harness: ExowattHarnessId,
  label: TrimmedNonEmptyString,
  kind: ExowattHarnessAssetKind,
  sourcePaths: Schema.Array(Schema.String),
  supportsToggle: Schema.Boolean,
  assets: Schema.Array(ExowattHarnessAsset),
  warnings: Schema.Array(Schema.String),
});
export type ExowattHarnessAssetInventory = typeof ExowattHarnessAssetInventory.Type;

export const ExowattHarnessAssetInventoryResult = Schema.Struct({
  harnesses: Schema.Array(ExowattHarnessAssetInventory),
});
export type ExowattHarnessAssetInventoryResult = typeof ExowattHarnessAssetInventoryResult.Type;

export const ExowattHarnessAssetListInput = Schema.Struct({
  kind: ExowattHarnessAssetKind,
});
export type ExowattHarnessAssetListInput = typeof ExowattHarnessAssetListInput.Type;

export const ExowattHarnessAssetToggleInput = Schema.Struct({
  harness: ExowattHarnessId,
  kind: ExowattHarnessAssetKind,
  name: TrimmedNonEmptyString,
  sourcePath: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ExowattHarnessAssetToggleInput = typeof ExowattHarnessAssetToggleInput.Type;

export class ExowattHarnessConfigError extends Schema.TaggedError<ExowattHarnessConfigError>()(
  "ExowattHarnessConfigError",
  {
    operation: Schema.String,
    path: Schema.optionalKey(Schema.String),
    reason: Schema.String,
  },
) {}
