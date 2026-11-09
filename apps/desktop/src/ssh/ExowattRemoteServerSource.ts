// Exowatt distro: locates the P3 server tarball a desktop installs on SSH remotes: packaged under
// `Contents/Resources/p3-server/`, or in dev `apps/desktop/dev-resources/p3-server/` from
// `pnpm exowatt:pack-dev-server`. The remote never runs upstream's `npx t3@<version>`.
import {
  EXOWATT_DEV_SERVER_VERSION_PREFIX,
  EXOWATT_P3_SERVER_COMPAT,
  type ExowattRemoteServerEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  compareExowattServerVersions,
  makeExowattPrepareRemoteRunner,
  type ExowattRemoteServerPackageSource,
} from "@t3tools/ssh/exowattRemoteServer";
import { SshLaunchError } from "@t3tools/ssh/errors";
import type { SshPrepareRemoteRunner } from "@t3tools/ssh/tunnel";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

/** Must match EXOWATT_REMOTE_SERVER_RESOURCE_DIR / _HASH_SUFFIX in the build script. */
export const EXOWATT_REMOTE_SERVER_RESOURCE_DIR = "p3-server";
export const EXOWATT_REMOTE_SERVER_HASH_SUFFIX = ".sha256";
/** Relative to the repo root; written by scripts/exowatt-pack-dev-server.ts. */
export const EXOWATT_DEV_SERVER_RESOURCE_DIR = "apps/desktop/dev-resources/p3-server";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function resolveExowattRemoteServerArchiveName(version: string): string {
  return `${serverPackageJson.name}-${version}.tgz`;
}

/** Inverse of resolveExowattRemoteServerArchiveName. */
export function parseExowattRemoteServerArchiveVersion(fileName: string): Option.Option<string> {
  const prefix = `${serverPackageJson.name}-`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".tgz")) return Option.none();
  const version = fileName.slice(prefix.length, -".tgz".length);
  return version.length > 0 ? Option.some(version) : Option.none();
}

export function resolveExowattRemoteServerArchivePath(input: {
  readonly path: Path.Path;
  readonly resourcesPath: string;
  readonly appVersion: string;
}): string {
  return input.path.join(
    input.resourcesPath,
    EXOWATT_REMOTE_SERVER_RESOURCE_DIR,
    resolveExowattRemoteServerArchiveName(input.appVersion),
  );
}

/** Parses the `<sha256>  <file>` sidecar written next to the tarball. */
export function parseExowattRemoteServerHash(content: string): Option.Option<string> {
  const digest = content.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  return SHA256_PATTERN.test(digest) ? Option.some(digest) : Option.none();
}

/** Builds a source for a tarball on disk, or `none` when its sidecar is unusable. */
const loadArchiveSource = Effect.fn("desktop/ssh/ExowattRemoteServerSource.load")(
  function* (input: { readonly archivePath: string; readonly version: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hashPath = `${input.archivePath}${EXOWATT_REMOTE_SERVER_HASH_SUFFIX}`;
    const hash = yield* fs.readFileString(hashPath).pipe(
      Effect.map(parseExowattRemoteServerHash),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(hash)) {
      yield* Effect.logWarning(
        `P3 remote server package at ${input.archivePath} has no valid ${EXOWATT_REMOTE_SERVER_HASH_SUFFIX} sidecar; ignoring it.`,
      );
      return Option.none<ExowattRemoteServerPackageSource>();
    }
    const source: ExowattRemoteServerPackageSource = {
      version: input.version,
      compat: EXOWATT_P3_SERVER_COMPAT,
      sha256: hash.value,
      archiveName: path.basename(input.archivePath),
      read: fs.readFile(input.archivePath).pipe(
        Effect.mapError(
          (cause) =>
            new SshLaunchError({
              message: `Could not read the P3 server package at ${input.archivePath}.`,
              stdout: "",
              cause,
            }),
        ),
      ),
    };
    return Option.some(source);
  },
);

/**
 * The tarball a packaged build ships for its own version. Builds without the
 * resource (and dev builds, whose resourcesPath is Electron's) resolve to `none`.
 */
export const resolveExowattRemoteServerSource = Effect.fn(
  "desktop/ssh/ExowattRemoteServerSource.resolve",
)(function* (input: { readonly resourcesPath: string; readonly appVersion: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archivePath = resolveExowattRemoteServerArchivePath({ path, ...input });
  const exists = yield* fs.exists(archivePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return Option.none<ExowattRemoteServerPackageSource>();
  return yield* loadArchiveSource({ archivePath, version: input.appVersion });
});

/**
 * The newest `t3-0.0.0-dev.<sha>.tgz` a dev worktree has packed, if any. Only
 * dev-versioned archives count so a stray release tarball cannot masquerade as
 * a dev push.
 */
export const resolveExowattDevRemoteServerSource = Effect.fn(
  "desktop/ssh/ExowattRemoteServerSource.resolveDev",
)(function* (input: { readonly rootDir: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(input.rootDir, EXOWATT_DEV_SERVER_RESOURCE_DIR);
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
  const candidates = entries
    .flatMap((name) => {
      const version = parseExowattRemoteServerArchiveVersion(name);
      return Option.isSome(version) && version.value.startsWith(EXOWATT_DEV_SERVER_VERSION_PREFIX)
        ? [{ name, version: version.value }]
        : [];
    })
    .toSorted((a, b) => compareExowattServerVersions(a.version, b.version));
  for (const candidate of candidates.toReversed()) {
    const source = yield* loadArchiveSource({
      archivePath: path.join(dir, candidate.name),
      version: candidate.version,
    });
    if (Option.isSome(source)) return source;
  }
  return Option.none<ExowattRemoteServerPackageSource>();
});

export interface ExowattRemoteServerEnvironment {
  readonly isDevelopment: boolean;
  readonly resourcesPath: string;
  readonly appVersion: string;
  readonly rootDir: string;
}

/** Packaged builds use the bundled tarball; dev builds use a packed dev tarball, if any. */
export const resolveExowattRemoteServerSourceForEnvironment = Effect.fn(
  "desktop/ssh/ExowattRemoteServerSource.resolveForEnvironment",
)(function* (environment: ExowattRemoteServerEnvironment) {
  const source = environment.isDevelopment
    ? yield* resolveExowattDevRemoteServerSource({ rootDir: environment.rootDir })
    : yield* resolveExowattRemoteServerSource({
        resourcesPath: environment.resourcesPath,
        appVersion: environment.appVersion,
      });
  return Option.getOrNull(source);
});

/**
 * The remote-preparation hook every P3 desktop installs, dev or packaged: the
 * remote runs a compatible installed P3 server, or the bundled one, or fails
 * with guidance. It never falls through to upstream's `npx t3@<spec>`.
 */
export function resolveExowattPrepareRemoteRunner(input: {
  readonly environment: ExowattRemoteServerEnvironment;
  readonly onEvent?: (event: ExowattRemoteServerEvent) => Effect.Effect<void>;
}): SshPrepareRemoteRunner {
  return makeExowattPrepareRemoteRunner({
    resolveSource: resolveExowattRemoteServerSourceForEnvironment(input.environment),
    compat: EXOWATT_P3_SERVER_COMPAT,
    isDevelopment: input.environment.isDevelopment,
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  });
}
