// Exowatt distro: SSH remotes run the P3 server build (with Phi), not stock `t3` from PATH or
// `npx t3@<version>`. The repo is private, so the desktop streams its server tarball over SSH,
// installs it under ~/.t3/p3-server/versions/<version>, and points the upstream runner at it
// via `nodeScriptPath`.
import {
  EXOWATT_NO_COMPATIBLE_REMOTE_SERVER_CODE,
  EXOWATT_P3_SERVER_COMPAT_MANIFEST_KEY,
  EXOWATT_STOCK_REMOTE_SERVER_CODE,
  ExowattRemoteStockServerStopResultSchema,
  isExowattDevServerVersion,
  type DesktopSshEnvironmentTarget,
  type ExowattRemoteServerEvent,
  type ExowattRemoteStockServerStopResult,
} from "@t3tools/contracts";
import { extractJsonObject, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import type { SshAuthOptions } from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError, SshInvalidTargetError, SshLaunchError } from "./errors.ts";
import {
  buildRemoteNodeEnvScript,
  type RemoteT3RunnerOptions,
  type SshPrepareRemoteRunner,
} from "./tunnel.ts";

const PROBE_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// Native dependencies (node-pty) may compile from source on the remote.
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const SAFE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Remote layout, relative to `$HOME`. */
export const EXOWATT_REMOTE_SERVER_ROOT = ".t3/p3-server";
export const EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL = ".install-complete";

/**
 * P3 server builds installed before the compat token existed (0.0.37-exowatt.*)
 * carry the `exowattP3Server` marker but no `exowattP3Compat`; they speak the
 * first revision.
 */
export const EXOWATT_LEGACY_P3_SERVER_COMPAT = "p3.1";

/**
 * Markers that identify a running server as a P3 build (see decide below):
 * an SSH-installed server, a versioned CLI, or the P3 Code desktop app's own
 * server when the remote is a Mac someone is also using directly.
 */
export const EXOWATT_SERVER_COMMAND_MARKERS = [
  `/${EXOWATT_REMOTE_SERVER_ROOT}/`,
  "-exowatt.",
  "/P3 Code.app/Contents/",
];

export interface ExowattRemoteServerPackageSource {
  readonly version: string;
  /** EXOWATT_P3_SERVER_COMPAT the tarball was built with. */
  readonly compat: string;
  readonly sha256: string;
  readonly archiveName: string;
  readonly read: Effect.Effect<Uint8Array, SshLaunchError>;
}

/** One `~/.t3/p3-server/versions/<version>` entry as reported by the probe. */
const RemoteInstalledServer = Schema.Struct({
  version: Schema.String,
  /** `exowattP3Compat` from the installed manifest; null when absent. */
  compat: Schema.NullOr(Schema.String),
  entryPath: Schema.String,
  /** Install sentinel present (npm install finished). */
  complete: Schema.Boolean,
});
export type ExowattRemoteInstalledServer = typeof RemoteInstalledServer.Type;

const RemoteProbeResult = Schema.Struct({
  node: Schema.Boolean,
  nodeVersion: Schema.optional(Schema.String),
  home: Schema.optional(Schema.String),
  installed: Schema.optional(Schema.Boolean),
  entryPath: Schema.optional(Schema.String),
  phiPath: Schema.optional(Schema.String),
  phiVersion: Schema.optional(Schema.String),
  installedServers: Schema.optional(Schema.Array(RemoteInstalledServer)),
  externalServer: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        pid: Schema.Number,
        port: Schema.optional(Schema.Number),
        command: Schema.String,
        managed: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type ExowattRemoteProbeResult = typeof RemoteProbeResult.Type;

const RemoteInstallResult = Schema.Struct({
  installed: Schema.Boolean,
  entryPath: Schema.String,
});

const decodeProbeResult = Schema.decodeEffect(fromLenientJson(RemoteProbeResult));
const decodeInstallResult = Schema.decodeEffect(fromLenientJson(RemoteInstallResult));

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function applyPlaceholders(template: string, replacements: Readonly<Record<string, string>>) {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`@@${token}@@`, value);
  }
  return result;
}

function describeTarget(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  return target.username ? `${target.username}@${destination}` : destination;
}

// Runs under the remote's `node`; prints one JSON line describing the host.
const REMOTE_PROBE_NODE_SCRIPT = `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const version = process.argv[2] || "";
const sha256 = process.argv[3] || "";
const home = os.homedir();
const versionDir = path.join(home, ${JSON.stringify(EXOWATT_REMOTE_SERVER_ROOT)}, "versions", version);
const entryPath = path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs");
function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim();
  } catch {
    return "";
  }
}
let installed = false;
try {
  installed =
    fs.existsSync(entryPath) &&
    fs.readFileSync(path.join(versionDir, ${JSON.stringify(EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL)}), "utf8").trim() === sha256;
} catch {}
// Every installed P3 server build, so the desktop can pick a compatible one
// instead of insisting on its own exact version.
const installedServers = [];
try {
  for (const name of fs.readdirSync(path.join(home, ${JSON.stringify(EXOWATT_REMOTE_SERVER_ROOT)}, "versions"))) {
    if (name.startsWith(".")) continue;
    const dir = path.join(home, ${JSON.stringify(EXOWATT_REMOTE_SERVER_ROOT)}, "versions", name);
    const entry = path.join(dir, "node_modules", "t3", "dist", "bin.mjs");
    if (!fs.existsSync(entry)) continue;
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", "t3", "package.json"), "utf8"));
    } catch {}
    const compatField = manifest[${JSON.stringify(EXOWATT_P3_SERVER_COMPAT_MANIFEST_KEY)}];
    installedServers.push({
      version: typeof manifest.version === "string" ? manifest.version : name,
      compat:
        typeof compatField === "string"
          ? compatField
          : manifest.exowattP3Server === true
            ? ${JSON.stringify(EXOWATT_LEGACY_P3_SERVER_COMPAT)}
            : null,
      entryPath: entry,
      complete: fs.existsSync(path.join(dir, ${JSON.stringify(EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL)})),
    });
  }
} catch {}
const phiPath = run("sh", ["-c", "command -v phi"]);
const phiVersion = phiPath ? run(phiPath, ["--version"]).split(/\\r?\\n/)[0] : "";
let externalServer = null;
try {
  const runtime = JSON.parse(
    fs.readFileSync(path.join(home, ".t3", "userdata", "server-runtime.json"), "utf8"),
  );
  const pid = Number(runtime.pid);
  if (Number.isInteger(pid) && pid > 0) {
    process.kill(pid, 0);
    let command = "";
    try {
      command = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").join(" ").trim();
    } catch {}
    if (!command) command = run("ps", ["-o", "args=", "-p", String(pid)]);
    // A server launched by a desktop's own ssh-launch state dir is "managed":
    // upstream's launch script restarts it when the runner changes, so it is
    // not a conflicting external service.
    let managed = false;
    const launchRoot = path.join(home, ".t3", "ssh-launch");
    try {
      for (const entry of fs.readdirSync(launchRoot)) {
        try {
          const statePid = Number(fs.readFileSync(path.join(launchRoot, entry, "pid"), "utf8").trim());
          let kind = "";
          try {
            kind = fs.readFileSync(path.join(launchRoot, entry, "managed"), "utf8").trim();
          } catch {}
          if (statePid === pid && kind !== "external") managed = true;
        } catch {}
      }
    } catch {}
    const port = Number(runtime.port);
    externalServer = Number.isInteger(port) ? { pid, port, command, managed } : { pid, command, managed };
  }
} catch {}
process.stdout.write(
  JSON.stringify({
    node: true,
    nodeVersion: process.versions.node,
    home,
    installed,
    entryPath,
    phiPath,
    phiVersion,
    installedServers,
    externalServer,
  }) + "\\n",
);
`;

export const EXOWATT_REMOTE_PROBE_SCRIPT = `set -eu
@@T3_NODE_ENV_SCRIPT@@
ensure_remote_node_path || true
if ! command -v node >/dev/null 2>&1; then
  printf '{"node":false}\\n'
  exit 0
fi
node - @@P3_VERSION@@ @@P3_SHA256@@ <<'NODE'
@@P3_PROBE_NODE_SCRIPT@@
NODE
`;

// Runs with the tarball on stdin; the login shell is not needed here.
export const EXOWATT_REMOTE_UPLOAD_SCRIPT = `set -eu
INCOMING="$HOME/@@P3_ROOT@@/incoming"
mkdir -p "$INCOMING"
cat >"$INCOMING/@@P3_ARCHIVE@@.part"
mv -f "$INCOMING/@@P3_ARCHIVE@@.part" "$INCOMING/@@P3_ARCHIVE@@"
`;

export const EXOWATT_REMOTE_INSTALL_SCRIPT = `set -eu
@@T3_NODE_ENV_SCRIPT@@
if ! ensure_remote_node_path; then
  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf 'Remote host has node but no npm on PATH; npm is required to install the P3 server package.\\n' >&2
  exit 1
fi
P3_ROOT="$HOME/@@P3_ROOT@@"
TGZ="$P3_ROOT/incoming/@@P3_ARCHIVE@@"
VERSION_DIR="$P3_ROOT/versions/@@P3_VERSION@@"
STAGING="$P3_ROOT/versions/.staging-@@P3_VERSION@@.$$"
ENTRY="node_modules/t3/dist/bin.mjs"
if [ ! -f "$TGZ" ]; then
  printf 'The P3 server package upload is missing at %s.\\n' "$TGZ" >&2
  exit 1
fi
ACTUAL_SHA256="$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TGZ")"
if [ "$ACTUAL_SHA256" != @@P3_SHA256@@ ]; then
  printf 'The uploaded P3 server package failed its checksum (expected %s, got %s).\\n' @@P3_SHA256@@ "$ACTUAL_SHA256" >&2
  rm -f "$TGZ"
  exit 1
fi
rm -rf "$STAGING"
mkdir -p "$STAGING"
if ! npm install --prefix "$STAGING" --no-fund --no-audit "$TGZ" >&2; then
  printf 'Installing the P3 server package on the remote host failed. Its native dependency (node-pty) needs a C toolchain: Debian/Ubuntu build-essential, Fedora/RHEL gcc-c++ make, macOS xcode-select --install. Fix that and reconnect.\\n' >&2
  rm -rf "$STAGING"
  exit 1
fi
if [ ! -f "$STAGING/$ENTRY" ]; then
  printf 'npm installed the P3 server package but produced no %s.\\n' "$ENTRY" >&2
  rm -rf "$STAGING"
  exit 1
fi
printf '%s\\n' @@P3_SHA256@@ >"$STAGING/@@P3_SENTINEL@@"
rm -rf "$VERSION_DIR"
mv "$STAGING" "$VERSION_DIR"
rm -f "$TGZ"
node -e 'process.stdout.write(JSON.stringify({ installed: true, entryPath: process.argv[1] }) + "\\n")' "$VERSION_DIR/$ENTRY"
`;

export function buildExowattRemoteProbeScript(input: {
  readonly version: string;
  readonly sha256: string;
  readonly runner: RemoteT3RunnerOptions | undefined;
}): string {
  return applyPlaceholders(EXOWATT_REMOTE_PROBE_SCRIPT, {
    T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input.runner),
    P3_VERSION: shellSingleQuote(input.version),
    P3_SHA256: shellSingleQuote(input.sha256),
    P3_PROBE_NODE_SCRIPT: REMOTE_PROBE_NODE_SCRIPT.replace(/\n+$/u, ""),
  });
}

export function buildExowattRemoteUploadScript(input: { readonly archiveName: string }): string {
  return applyPlaceholders(EXOWATT_REMOTE_UPLOAD_SCRIPT, {
    P3_ROOT: EXOWATT_REMOTE_SERVER_ROOT,
    P3_ARCHIVE: input.archiveName,
  });
}

export function buildExowattRemoteInstallScript(input: {
  readonly version: string;
  readonly sha256: string;
  readonly archiveName: string;
  readonly runner: RemoteT3RunnerOptions | undefined;
}): string {
  return applyPlaceholders(EXOWATT_REMOTE_INSTALL_SCRIPT, {
    T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input.runner),
    P3_ROOT: EXOWATT_REMOTE_SERVER_ROOT,
    P3_ARCHIVE: input.archiveName,
    P3_VERSION: input.version,
    P3_SHA256: shellSingleQuote(input.sha256),
    P3_SENTINEL: EXOWATT_REMOTE_SERVER_INSTALL_SENTINEL,
  });
}

export function isExowattServerCommand(command: string): boolean {
  return EXOWATT_SERVER_COMMAND_MARKERS.some((marker) => command.includes(marker));
}

/** Numeric-aware version ordering; `0.0.0-dev.<sha>` sorts below every release. */
export function compareExowattServerVersions(a: string, b: string): number {
  const split = (value: string) => value.split(/[.-]/u).filter((part) => part.length > 0);
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return r === undefined ? 0 : /^\d+$/u.test(r) ? -1 : 1;
    if (r === undefined) return /^\d+$/u.test(l) ? 1 : -1;
    const ln = /^\d+$/u.test(l) ? Number(l) : NaN;
    const rn = /^\d+$/u.test(r) ? Number(r) : NaN;
    if (!Number.isNaN(ln) && !Number.isNaN(rn)) {
      if (ln !== rn) return ln < rn ? -1 : 1;
      continue;
    }
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export type ExowattRemotePreparationDecision =
  /** Run an installed compatible server; optionally stage a newer one afterwards. */
  | {
      readonly kind: "ready";
      readonly entryPath: string;
      readonly version: string;
      /** Set when the desktop bundles a newer compatible build than `version`. */
      readonly backgroundUpgrade: string | null;
    }
  /** No compatible server on the remote: install the bundled one before launch. */
  | { readonly kind: "install"; readonly version: string }
  | { readonly kind: "fail"; readonly message: string };

/**
 * Picks the server the remote runs. Compatibility, not equality: any complete install with the
 * desktop's compat token works. Prefer the desktop's bundled version when installed, else the
 * newest compatible release; pushed dev builds only when nothing else is compatible.
 */
export function decideExowattRemotePreparation(input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly probe: ExowattRemoteProbeResult;
  /** The bundled tarball, or null for a dev build that has not packed one. */
  readonly source: Pick<ExowattRemoteServerPackageSource, "version" | "compat"> | null;
  readonly compat: string;
  readonly isDevelopment: boolean;
}): ExowattRemotePreparationDecision {
  const { probe, target, source } = input;
  const host = describeTarget(target);
  if (!probe.node) {
    // The P3 server is a Node script. Handing upstream's runner back here would
    // let its self-contained release archive, which needs no Node, download
    // and start stock T3 instead.
    return {
      kind: "fail",
      message:
        `Remote host ${host} is missing node on PATH for non-interactive login shells. ` +
        `The P3 Code server runs on Node: install Node or configure a supported version manager for non-interactive shells, then reconnect.`,
    };
  }
  const external = probe.externalServer ?? null;
  if (external !== null && external.managed !== true && !isExowattServerCommand(external.command)) {
    const where =
      external.port !== undefined && Number.isInteger(external.port)
        ? `pid ${String(external.pid)}, port ${String(external.port)}`
        : `pid ${String(external.pid)}`;
    return {
      kind: "fail",
      message:
        `Remote host ${host} is already running a stock T3 Code server (${where}) on the shared ~/.t3 data directory, so P3 Code cannot start its own server there and Phi would be unavailable. ` +
        `Stop it and reconnect: for the background service run 'systemctl --user disable --now t3code.service' on the remote, or replace it with the P3 server build. ` +
        `Running command: ${external.command || "(unknown)"} [${EXOWATT_STOCK_REMOTE_SERVER_CODE}]`,
    };
  }
  const phiPath = probe.phiPath?.trim() ?? "";
  if (phiPath.length === 0) {
    return {
      kind: "fail",
      message:
        `Remote host ${host} has no 'phi' on PATH for non-interactive login shells (checked with sh -lc 'command -v phi'). ` +
        `P3 Code's default provider needs Phi on the remote. Install it there (see docs/user/providers-phi.md, e.g. 'npm install --global @earendil-works/pi-coding-agent@0.83.0') or add its directory to PATH in ~/.profile, then reconnect.`,
    };
  }
  const compatible = (probe.installedServers ?? []).filter(
    (server) => server.complete && server.compat === input.compat,
  );
  const exact =
    source === null ? undefined : compatible.find((server) => server.version === source.version);
  if (exact !== undefined) {
    return {
      kind: "ready",
      entryPath: exact.entryPath,
      version: exact.version,
      backgroundUpgrade: null,
    };
  }
  const releases = compatible.filter((server) => !isExowattDevServerVersion(server.version));
  const pool = releases.length > 0 ? releases : compatible;
  const best = pool.toSorted((a, b) => compareExowattServerVersions(a.version, b.version)).at(-1);
  if (best !== undefined) {
    const upgrade =
      source !== null &&
      source.compat === input.compat &&
      !isExowattDevServerVersion(source.version) &&
      compareExowattServerVersions(source.version, best.version) > 0
        ? source.version
        : null;
    return {
      kind: "ready",
      entryPath: best.entryPath,
      version: best.version,
      backgroundUpgrade: upgrade,
    };
  }
  if (source !== null) {
    return { kind: "install", version: source.version };
  }
  const installed = (probe.installedServers ?? []).map(
    (server) => `${server.version} (${server.compat ?? "no compat token"})`,
  );
  return {
    kind: "fail",
    message:
      `Remote host ${host} has no P3 Code server compatible with this ${input.isDevelopment ? "dev build" : "build"} (${input.compat})` +
      (installed.length > 0 ? `; installed: ${installed.join(", ")}` : "") +
      `. P3 Code never runs the stock T3 server on a remote. ` +
      (input.isDevelopment
        ? `Connect once from the released P3 Code app to install its server, or run 'pnpm exowatt:pack-dev-server' in the worktree and use "Push dev server to this host".`
        : `Update P3 Code on this machine and reconnect.`) +
      ` [${EXOWATT_NO_COMPATIBLE_REMOTE_SERVER_CODE}]`,
  };
}

const decodeRemoteJson = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) return yield* Effect.fail(error);
        const exit = yield* Effect.exit(decode(jsonObject));
        return Exit.isSuccess(exit) ? exit.value : yield* Effect.fail(error);
      }),
    ),
  );

function authFields(input: SshAuthOptions) {
  return {
    ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  };
}

function targetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

/**
 * Uploads the tarball and runs `npm install` into
 * `~/.t3/p3-server/versions/<version>/`. Each version has its own directory,
 * so this is safe while another version is serving (background upgrades, dev
 * pushes). `runner` only supplies upstream's node-discovery env script.
 */
export const installExowattRemoteServer = Effect.fn("ssh/exowattRemoteServer.install")(function* (
  source: ExowattRemoteServerPackageSource,
  target: DesktopSshEnvironmentTarget,
  authOptions: SshAuthOptions,
  runner?: RemoteT3RunnerOptions,
): Effect.fn.Return<
  { readonly entryPath: string; readonly version: string },
  SshCommandError | SshInvalidTargetError | SshLaunchError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  if (!SAFE_VERSION_PATTERN.test(source.version) || !SHA256_PATTERN.test(source.sha256)) {
    return yield* new SshLaunchError({
      message: `P3 Code cannot prepare the remote host: invalid server package metadata (version '${source.version}').`,
      stdout: "",
    });
  }
  const logFields = { ...targetLogFields(target), version: source.version };
  const bytes = yield* source.read;
  yield* Effect.logInfo("ssh.exowatt.remoteServer.upload.start", {
    ...logFields,
    archiveName: source.archiveName,
    bytes: bytes.byteLength,
  });
  yield* runSshCommand(target, {
    remoteCommandArgs: [
      "sh",
      "-c",
      shellSingleQuote(buildExowattRemoteUploadScript({ archiveName: source.archiveName })),
    ],
    stdin: bytes,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    ...authFields(authOptions),
  });
  yield* Effect.logInfo("ssh.exowatt.remoteServer.install.start", logFields);
  const installResult = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-l", "-s"],
    stdin: buildExowattRemoteInstallScript({
      version: source.version,
      sha256: source.sha256,
      archiveName: source.archiveName,
      runner,
    }),
    timeoutMs: INSTALL_TIMEOUT_MS,
    ...authFields(authOptions),
  });
  const installed = yield* decodeRemoteJson(installResult.stdout, decodeInstallResult).pipe(
    Effect.mapError(
      (cause) =>
        new SshLaunchError({
          message: "P3 Code could not read the remote server install result.",
          stdout: installResult.stdout,
          cause,
        }),
    ),
  );
  yield* Effect.logInfo("ssh.exowatt.remoteServer.install.succeeded", {
    ...logFields,
    entryPath: installed.entryPath,
  });
  return { entryPath: installed.entryPath, version: source.version };
});

export interface ExowattPrepareRemoteRunnerOptions {
  /**
   * Bundled tarball (packaged builds) or the worktree's packed dev tarball;
   * null when none. Re-resolved on every connect so a dev tarball packed after
   * launch is picked up.
   */
  readonly resolveSource: Effect.Effect<
    ExowattRemoteServerPackageSource | null,
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly compat: string;
  readonly isDevelopment: boolean;
  /** Receives the outcome of background upgrades (renderer toast). */
  readonly onEvent?: (event: ExowattRemoteServerEvent) => Effect.Effect<void>;
}

/**
 * The `prepareRemoteRunner` hook: points the upstream runner's `nodeScriptPath` at a compatible
 * installed P3 server (installing the bundled one first if needed) or fails with `SshLaunchError`,
 * never upstream's `npx t3@<spec>`. A newer bundled build is staged after connect for next time.
 */
export function makeExowattPrepareRemoteRunner(
  options: ExowattPrepareRemoteRunnerOptions,
): SshPrepareRemoteRunner {
  const upgradesInFlight = new Set<string>();
  return Effect.fn("ssh/exowattRemoteServer.prepare")(function* (
    target: DesktopSshEnvironmentTarget,
    runner: RemoteT3RunnerOptions | undefined,
    authOptions: SshAuthOptions,
  ): Effect.fn.Return<
    RemoteT3RunnerOptions | undefined,
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    // Upstream's dev knob T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH is explicit: honour it.
    if (options.isDevelopment && runner?.nodeScriptPath !== undefined) {
      return runner;
    }
    const source = yield* options.resolveSource;
    yield* Effect.logInfo("ssh.exowatt.remoteServer.probe.start", targetLogFields(target));
    const probeResult = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-l", "-s"],
      stdin: buildExowattRemoteProbeScript({
        version: source?.version ?? "",
        sha256: source?.sha256 ?? "",
        runner,
      }),
      timeoutMs: PROBE_TIMEOUT_MS,
      ...authFields(authOptions),
    });
    const probe = yield* decodeRemoteJson(probeResult.stdout, decodeProbeResult).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "P3 Code could not read the remote host probe result.",
            stdout: probeResult.stdout,
            cause,
          }),
      ),
    );
    const decision = decideExowattRemotePreparation({
      target,
      probe,
      source,
      compat: options.compat,
      isDevelopment: options.isDevelopment,
    });
    yield* Effect.logInfo("ssh.exowatt.remoteServer.probe.result", {
      ...targetLogFields(target),
      bundledVersion: source?.version ?? null,
      compat: options.compat,
      decision: decision.kind,
      nodeVersion: probe.nodeVersion ?? null,
      phiPath: probe.phiPath ?? null,
      phiVersion: probe.phiVersion ?? null,
      externalServer: probe.externalServer ?? null,
      installedServers: probe.installedServers ?? [],
      ...(decision.kind === "ready"
        ? { version: decision.version, backgroundUpgrade: decision.backgroundUpgrade }
        : {}),
    });
    switch (decision.kind) {
      case "fail":
        return yield* new SshLaunchError({ message: decision.message, stdout: probeResult.stdout });
      case "ready": {
        if (decision.backgroundUpgrade !== null && source !== null) {
          yield* stageUpgradeInBackground({
            source,
            target,
            authOptions,
            runner,
            previousVersion: decision.version,
            inFlight: upgradesInFlight,
            onEvent: options.onEvent,
          });
        }
        return { ...runner, nodeScriptPath: decision.entryPath };
      }
      case "install": {
        if (source === null) return runner; // unreachable: decide() only installs with a source
        const installed = yield* installExowattRemoteServer(source, target, authOptions, runner);
        return { ...runner, nodeScriptPath: installed.entryPath };
      }
    }
  });
}

const stageUpgradeInBackground = Effect.fn("ssh/exowattRemoteServer.backgroundUpgrade")(
  function* (input: {
    readonly source: ExowattRemoteServerPackageSource;
    readonly target: DesktopSshEnvironmentTarget;
    readonly authOptions: SshAuthOptions;
    readonly runner: RemoteT3RunnerOptions | undefined;
    readonly previousVersion: string;
    readonly inFlight: Set<string>;
    readonly onEvent: ExowattPrepareRemoteRunnerOptions["onEvent"];
  }): Effect.fn.Return<
    void,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const host = describeTarget(input.target);
    const key = `${host}#${input.source.version}`;
    if (input.inFlight.has(key)) return;
    input.inFlight.add(key);
    const upgrade = installExowattRemoteServer(
      input.source,
      input.target,
      input.authOptions,
      input.runner,
    ).pipe(
      Effect.flatMap(
        () =>
          input.onEvent?.({
            type: "upgraded",
            host,
            version: input.source.version,
            previousVersion: input.previousVersion,
          }) ?? Effect.void,
      ),
      Effect.catch((error: SshCommandError | SshInvalidTargetError | SshLaunchError) =>
        Effect.logWarning("ssh.exowatt.remoteServer.backgroundUpgrade.failed", {
          ...targetLogFields(input.target),
          version: input.source.version,
          error: error.message,
        }).pipe(
          Effect.andThen(
            input.onEvent?.({
              type: "upgrade-failed",
              host,
              version: input.source.version,
              message: error.message,
            }) ?? Effect.void,
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => input.inFlight.delete(key))),
    );
    // Detached from the connect: the tunnel comes up on the installed server now
    // and the staged build is picked on the next connect.
    yield* Effect.forkDetach(upgrade);
  },
);

const STOP_STOCK_SERVER_TIMEOUT_MS = 30_000;

/**
 * Stops upstream's stock T3 server so P3 can start on the shared ~/.t3: disables its user service
 * (systemd `t3code.service` or launchd) and signals stray stock `t3 ... serve` processes running
 * from ~/.t3/runtime (never ~/.t3/p3-server). The stock runtime stays on disk. POSIX sh only.
 */
export const EXOWATT_REMOTE_STOP_STOCK_SERVER_SCRIPT = `set -u
SERVICE="absent"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user cat t3code.service >/dev/null 2>&1; then
    if systemctl --user disable --now t3code.service >&2; then
      SERVICE="disabled"
    else
      printf 'systemctl --user disable --now t3code.service failed on the remote host.\\n' >&2
      exit 1
    fi
  fi
elif command -v launchctl >/dev/null 2>&1; then
  PLIST="$HOME/Library/LaunchAgents/com.t3tools.t3code.service.plist"
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/com.t3tools.t3code.service" >/dev/null 2>&1 || true
    mv -f "$PLIST" "$PLIST.disabled-by-p3" && SERVICE="disabled"
  fi
else
  SERVICE="unsupported"
fi
# Any stock \`t3 ... serve\` owned by this user: the pinned runtime under
# ~/.t3/runtime, an npx-launched one (~/.npm/_npx/.../.bin/t3, as upstream's
# remote bootstrap starts), or a global install. P3 servers live under
# ~/.t3/p3-server and are never matched. (A function, because bash 3.2,
# macOS /bin/sh, cannot parse a case statement inside "$(...)".)
stop_stock_servers() {
  ps -u "$(id -u)" -o pid= -o args= 2>/dev/null | while read -r pid args; do
    [ "$pid" = "$$" ] && continue
    case "$args" in
      *"/.t3/p3-server/"*) ;;
      *"/t3/dist/bin.mjs serve"*|*"/.bin/t3 serve"*|*"/bin/t3 serve"*)
        kill "$pid" 2>/dev/null && printf '%s,' "$pid" ;;
    esac
  done
}
STOPPED="$(stop_stock_servers)"
STOPPED="\${STOPPED%,}"
[ -n "$STOPPED" ] && sleep 1
printf '{"service":"%s","stoppedPids":[%s]}\\n' "$SERVICE" "$STOPPED"
`;

const decodeStopResult = Schema.decodeEffect(
  fromLenientJson(ExowattRemoteStockServerStopResultSchema),
);

/** One-click remediation for the EXOWATT_STOCK_REMOTE_SERVER_CODE connection error. */
export const stopExowattRemoteStockServer = Effect.fn("ssh/exowattRemoteServer.stopStockServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    authOptions: SshAuthOptions,
  ): Effect.fn.Return<
    ExowattRemoteStockServerStopResult,
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    yield* Effect.logInfo("ssh.exowatt.remoteServer.stopStock.start", targetLogFields(target));
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s"],
      stdin: EXOWATT_REMOTE_STOP_STOCK_SERVER_SCRIPT,
      timeoutMs: STOP_STOCK_SERVER_TIMEOUT_MS,
      ...authFields(authOptions),
    });
    const decoded = yield* decodeRemoteJson(result.stdout, decodeStopResult).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: `P3 Code could not read the result of stopping the stock T3 Code server on ${describeTarget(target)}.`,
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    yield* Effect.logInfo("ssh.exowatt.remoteServer.stopStock.result", {
      ...targetLogFields(target),
      service: decoded.service,
      stoppedPids: decoded.stoppedPids,
    });
    return decoded;
  },
);
