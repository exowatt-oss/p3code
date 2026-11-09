// @effect-diagnostics nodeBuiltinImport:off - synchronous, layer-free marker lookup.
// Exowatt distro: the P3 desktop installs its own server build on SSH remotes
// (packages/ssh/src/exowattRemoteServer.ts). Upstream's background-service
// paths (`t3 service install`, remote self-update) install stock `t3@<version>`
// from the public npm registry into <baseDir>/runtime, which would silently
// replace that P3 server (and lose the Phi adapter). This module detects a P3
// server build so those paths can refuse instead.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Manual override: `1`/`true` forces P3 mode, `0`/`false` forces upstream
 * behaviour. Unset means "consult the package manifest marker".
 */
export const EXOWATT_P3_SERVER_ENV = "EXOWATT_P3_SERVER";

/**
 * Top-level `package.json` field the P3 tarball manifest carries
 * (scripts/lib/exowatt-remote-server-package.ts). The repo's own
 * `apps/server/package.json` does not have it, so dev builds, locally built
 * dists and the desktop-bundled server keep upstream behaviour.
 */
export const EXOWATT_P3_SERVER_MANIFEST_KEY = "exowattP3Server";

export interface ExowattP3ServerDetection {
  readonly p3Server: boolean;
  /** Which signal decided, for the one-line log. */
  readonly source: "env" | "manifest" | "none";
}

export function detectExowattP3Server(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly manifest: unknown;
}): ExowattP3ServerDetection {
  const flag = input.env[EXOWATT_P3_SERVER_ENV]?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return { p3Server: true, source: "env" };
  if (flag === "0" || flag === "false") return { p3Server: false, source: "env" };
  const manifest = input.manifest;
  const marker =
    typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, unknown>)[EXOWATT_P3_SERVER_MANIFEST_KEY]
      : undefined;
  return marker === true
    ? { p3Server: true, source: "manifest" }
    : { p3Server: false, source: "none" };
}

/**
 * The server ships as a flat `dist/` bundle next to its `package.json`
 * (`node_modules/t3/dist/*.mjs` on a remote); from source this resolves to
 * `apps/server/package.json`, which carries no marker.
 */
export function resolveExowattServerManifestPath(moduleUrl: string): string {
  return NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(moduleUrl)), "..", "package.json");
}

export function readExowattServerManifest(manifestPath: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
}

let cachedManifest: { readonly value: unknown } | undefined;

/** Current-process detection; the env override is re-read on every call. */
export function currentExowattP3ServerDetection(): ExowattP3ServerDetection {
  if (cachedManifest === undefined) {
    cachedManifest = {
      value: readExowattServerManifest(resolveExowattServerManifestPath(import.meta.url)),
    };
  }
  return detectExowattP3Server({ env: process.env, manifest: cachedManifest.value });
}

/** One-line, user-facing reason for refusing a stock `t3@<version>` install. */
export function exowattP3ServerRefusalReason(
  targetVersion: string,
  detection: ExowattP3ServerDetection,
): string {
  const signal =
    detection.source === "env"
      ? `${EXOWATT_P3_SERVER_ENV} is set`
      : `package.json has ${EXOWATT_P3_SERVER_MANIFEST_KEY}`;
  return (
    `This is the P3 Code server installed by the P3 desktop app (${signal}); ` +
    `installing stock t3@${targetVersion} from npm is disabled so Phi stays available. ` +
    `Update P3 Code on your machine and reconnect to upgrade this server.`
  );
}
