// Exowatt distro: the P3 desktop ships its server build as an npm-style tarball so SSH remotes run
// the P3 server (with Phi) instead of upstream `t3@<version>` from npm. The repo is private, so the
// desktop streams the tarball over the SSH session (packages/ssh/src/exowattRemoteServer.ts).
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  EXOWATT_P3_SERVER_COMPAT,
  EXOWATT_P3_SERVER_COMPAT_MANIFEST_KEY,
} from "@t3tools/shared/exowatt";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

/** Resource directory (below `Contents/Resources`) that holds the tarball. */
export const EXOWATT_REMOTE_SERVER_RESOURCE_DIR = "p3-server";

/** Sidecar written next to the tarball so operators can verify it by hand. */
export const EXOWATT_REMOTE_SERVER_HASH_SUFFIX = ".sha256";

export const EXOWATT_REMOTE_SERVER_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${EXOWATT_REMOTE_SERVER_RESOURCE_DIR}`,
  to: EXOWATT_REMOTE_SERVER_RESOURCE_DIR,
} as const;

// The tarball must not be duplicated into app.asar; it only ships as a resource.
export const EXOWATT_REMOTE_SERVER_FILE_EXCLUSIONS = [
  `!${EXOWATT_REMOTE_SERVER_EXTRA_RESOURCE.from}`,
  `!${EXOWATT_REMOTE_SERVER_EXTRA_RESOURCE.from}/**/*`,
] as const;

/** `npm pack` names the archive `<name>-<version>.tgz`. */
export function resolveExowattRemoteServerPackageFileName(version: string): string {
  return `${serverPackageJson.name}-${version}.tgz`;
}

export interface ExowattRemoteServerPackageJson {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly type: string;
  readonly bin: Record<string, string>;
  readonly files: ReadonlyArray<string>;
  readonly engines: Record<string, string>;
  readonly dependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
  /** Marks a P3 server build; see apps/server/src/cloud/exowattP3Server.ts. */
  readonly exowattP3Server: true;
  /** Desktop/server compatibility token; see EXOWATT_P3_SERVER_COMPAT. */
  readonly [EXOWATT_P3_SERVER_COMPAT_MANIFEST_KEY]: string;
}

/**
 * The bundle inlines everything except the CLI runtime externals, so the manifest lists only those
 * (anything else, e.g. `workspace:*` providers, breaks the remote `npm install`). `catalog:` specs
 * arrive resolved, and the version pins the remote install to the desktop build that shipped it.
 */
export function buildExowattRemoteServerPackageJson(input: {
  readonly version: string;
  readonly dependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
}): ExowattRemoteServerPackageJson {
  return {
    name: serverPackageJson.name,
    version: input.version,
    license: serverPackageJson.license,
    type: serverPackageJson.type,
    bin: serverPackageJson.bin,
    files: serverPackageJson.files,
    engines: serverPackageJson.engines,
    dependencies: selectCliRuntimeExternalDependencies(input.dependencies),
    overrides: selectNpmCompatibleOverrides(input.overrides),
    // The server reads this at runtime to refuse stock `t3` npm self-updates.
    exowattP3Server: true,
    // The desktop's remote probe reads this to pick a compatible installed server.
    [EXOWATT_P3_SERVER_COMPAT_MANIFEST_KEY]: EXOWATT_P3_SERVER_COMPAT,
  };
}

/**
 * Upstream publishes with pnpm, which accepts `parent>child` override
 * selectors. `npm pack` rejects those keys as invalid package names, and npm
 * ignores a dependency's `overrides` anyway (only the root manifest's apply),
 * so the remote install behaves exactly like `npx t3@<version>` without them.
 */
export function selectNpmCompatibleOverrides(
  overrides: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(overrides).filter(([name]) => !name.includes(">")));
}

export class ExowattRemoteServerPackageError extends Schema.TaggedError<ExowattRemoteServerPackageError>()(
  "ExowattRemoteServerPackageError",
  {
    step: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to stage the P3 remote server package while ${this.step}.${
      this.detail ? ` ${this.detail}` : ""
    }`;
  }
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

/**
 * Packs `apps/server/dist` plus a release manifest into
 * `<stageResourcesDir>/p3-server/t3-<version>.tgz` and returns the archive path.
 */
export const stageExowattRemoteServerPackage = Effect.fn("stageExowattRemoteServerPackage")(
  function* (input: {
    readonly serverDistDir: string;
    readonly stageResourcesDir: string;
    readonly version: string;
    readonly dependencies: Record<string, string>;
    readonly overrides: Record<string, string>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const outputDir = path.join(input.stageResourcesDir, EXOWATT_REMOTE_SERVER_RESOURCE_DIR);
    const archiveName = resolveExowattRemoteServerPackageFileName(input.version);
    const archivePath = path.join(outputDir, archiveName);

    const packageDir = yield* fs
      .makeTempDirectoryScoped({ prefix: "p3-remote-server-" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ExowattRemoteServerPackageError({ step: "creating the pack directory", cause }),
        ),
      );
    const manifest = buildExowattRemoteServerPackageJson({
      version: input.version,
      dependencies: input.dependencies,
      overrides: input.overrides,
    });
    const manifestString = yield* encodePackageJson(manifest).pipe(
      Effect.mapError(
        (cause) =>
          new ExowattRemoteServerPackageError({ step: "encoding the package manifest", cause }),
      ),
    );
    yield* Effect.all([
      fs.writeFileString(path.join(packageDir, "package.json"), `${manifestString}\n`),
      fs.copy(input.serverDistDir, path.join(packageDir, "dist")),
      fs.makeDirectory(outputDir, { recursive: true }),
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new ExowattRemoteServerPackageError({ step: "staging the server bundle", cause }),
      ),
    );

    const child = yield* spawner
      .spawn(
        // npm lists every packed file on stderr at the default log level; keep
        // that quiet so the build log stays readable and the pipe never fills.
        ChildProcess.make(
          "npm",
          ["pack", "--ignore-scripts", "--loglevel=error", "--pack-destination", outputDir],
          { cwd: packageDir, stdout: "ignore", stderr: "inherit" },
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) => new ExowattRemoteServerPackageError({ step: "spawning npm pack", cause }),
        ),
      );
    const exitCode = yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) => new ExowattRemoteServerPackageError({ step: "running npm pack", cause }),
      ),
    );
    if (Number(exitCode) !== 0) {
      return yield* new ExowattRemoteServerPackageError({
        step: "running npm pack",
        detail: `npm exited with ${String(exitCode)}.`,
      });
    }
    if (!(yield* fs.exists(archivePath).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new ExowattRemoteServerPackageError({
        step: "locating the packed archive",
        detail: `Expected ${archivePath}.`,
      });
    }

    const archiveBytes = yield* fs
      .readFile(archivePath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ExowattRemoteServerPackageError({ step: "hashing the packed archive", cause }),
        ),
      );
    const digest = yield* Effect.promise(() =>
      globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(archiveBytes)),
    );
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    yield* fs
      .writeFileString(
        `${archivePath}${EXOWATT_REMOTE_SERVER_HASH_SUFFIX}`,
        `${sha256}  ${archiveName}\n`,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ExowattRemoteServerPackageError({ step: "writing the archive hash", cause }),
        ),
      );

    return { archivePath, archiveName, sha256, bytes: archiveBytes.byteLength } as const;
  },
);
