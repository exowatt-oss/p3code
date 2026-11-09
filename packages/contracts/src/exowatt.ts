// Exowatt distro: shared vocabulary for the P3 remote-host flow
// (packages/ssh/src/exowattRemoteServer.ts, apps/desktop, apps/web).
import * as Schema from "effect/Schema";

/**
 * Stable token embedded in the connection error raised when a remote host is
 * still running upstream's stock T3 Code server on the shared ~/.t3 directory.
 * Only the message string survives the trip to the renderer, so the web app
 * keys its one-click remediation off this token rather than on prose.
 */
export const EXOWATT_STOCK_REMOTE_SERVER_CODE = "P3-STOCK-REMOTE-SERVER";

export function isExowattStockRemoteServerError(message: string | null | undefined): boolean {
  return typeof message === "string" && message.includes(EXOWATT_STOCK_REMOTE_SERVER_CODE);
}

/**
 * Token in the connection error raised when no installed remote server is
 * compatible and the desktop has no tarball to install (dev builds). The web
 * app offers the dev-only "push dev server" action off this token.
 */
export const EXOWATT_NO_COMPATIBLE_REMOTE_SERVER_CODE = "P3-NO-COMPATIBLE-REMOTE-SERVER";

export function isExowattNoCompatibleRemoteServerError(
  message: string | null | undefined,
): boolean {
  return typeof message === "string" && message.includes(EXOWATT_NO_COMPATIBLE_REMOTE_SERVER_CODE);
}

/**
 * Server compatibility token in the P3 server tarball manifest (`exowattP3Compat`), read back by
 * the remote probe: a remote P3 server with an equal token is accepted whatever its version.
 * Bump it whenever the desktop/server wire contract changes (p3.6: upstream 0.1.8).
 */
export const EXOWATT_P3_SERVER_COMPAT = "p3.6";
export const EXOWATT_P3_SERVER_COMPAT_MANIFEST_KEY = "exowattP3Compat";

/**
 * Pushed dev servers are versioned `0.0.0-dev.<sha>` (npm requires semver) so
 * they sort below every release and never overwrite a release install.
 */
export const EXOWATT_DEV_SERVER_VERSION_PREFIX = "0.0.0-dev.";

export function isExowattDevServerVersion(version: string): boolean {
  return version.startsWith(EXOWATT_DEV_SERVER_VERSION_PREFIX);
}

/** Pushed to the renderer when a background remote server upgrade finishes. */
export const ExowattRemoteServerEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("upgraded"),
    host: Schema.String,
    version: Schema.String,
    previousVersion: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("upgrade-failed"),
    host: Schema.String,
    version: Schema.String,
    message: Schema.String,
  }),
]);
export type ExowattRemoteServerEvent = typeof ExowattRemoteServerEventSchema.Type;

/** Result of pushing the dev worktree's server build to a remote. */
export const ExowattPushDevServerResultSchema = Schema.Struct({
  version: Schema.String,
  entryPath: Schema.String,
});
export type ExowattPushDevServerResult = typeof ExowattPushDevServerResultSchema.Type;

/** Result of stopping upstream's stock server on a remote host. */
export const ExowattRemoteStockServerStopResultSchema = Schema.Struct({
  /** What happened to the background-service unit (systemd or launchd). */
  service: Schema.Literals(["disabled", "absent", "unsupported"]),
  /** Stray stock `t3 ... serve` processes that were signalled, if any. */
  stoppedPids: Schema.Array(Schema.Number),
});
export type ExowattRemoteStockServerStopResult =
  typeof ExowattRemoteStockServerStopResultSchema.Type;
