// @effect-diagnostics nodeBuiltinImport:off - this is a process-level packaging regression test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { it } from "@effect/vitest";

import serverPackageJson from "../../package.json" with { type: "json" };
import { stageExowattRemoteServerPackage } from "../../../../scripts/lib/exowatt-remote-server-package.ts";
import { resolveCatalogDependencies } from "../../../../scripts/lib/resolve-catalog.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const vpBin = NodePath.join(repoRoot, "node_modules/.bin/vp");
const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

type PackageManifest = {
  readonly dependencies: Record<string, string>;
};

function run(command: string, args: ReadonlyArray<string>, cwd: string): void {
  NodeChildProcess.execFileSync(command, args, { cwd, stdio: "inherit" });
}

function writeSmokePackageJson(installRoot: string): void {
  NodeFS.writeFileSync(
    NodePath.join(installRoot, "package.json"),
    JSON.stringify({ name: "t3-exowatt-remote-smoke", private: true }, null, 2),
  );
}

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Real `npm install` from the registry; a cold cache can exceed the 60s project ceiling.
it.effect(
  "loads the npm-installed Exowatt remote bundle",
  () =>
    Effect.gen(function* () {
      // Build the normal dist bundle. This deliberately does not set T3CODE_PACK_EXE:
      // the archive installed below must exercise the npm-compatible ESM path.
      run(vpBin, ["run", "--filter=t3", "build:bundle"], repoRoot);

      const workspace = yield* decodeWorkspaceConfig(
        NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
      );
      const packageManifest = serverPackageJson as PackageManifest;
      const dependencies = resolveCatalogDependencies(
        packageManifest.dependencies,
        workspace.catalog ?? {},
        "apps/server",
      );
      const overrides = resolveCatalogDependencies(
        workspace.overrides ?? {},
        workspace.catalog ?? {},
        "pnpm-workspace.yaml",
      );

      const tempRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-exowatt-remote-smoke-"),
      );
      yield* Effect.gen(function* () {
        const staged = yield* stageExowattRemoteServerPackage({
          serverDistDir: NodePath.join(repoRoot, "apps/server/dist"),
          stageResourcesDir: tempRoot,
          version: "0.0.0-smoke.0",
          dependencies,
          overrides,
        }).pipe(Effect.scoped);
        const installRoot = NodePath.join(tempRoot, "install");
        NodeFS.mkdirSync(installRoot, { recursive: true });
        writeSmokePackageJson(installRoot);

        // npm, rather than pnpm, is intentional: the remote SSH installer uses npm
        // and therefore never applies this repository's pnpm patchedDependencies.
        run(
          "npm",
          [
            "install",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--prefix",
            installRoot,
            staged.archivePath,
          ],
          repoRoot,
        );

        const installedEntry = NodePath.join(installRoot, "node_modules/t3/dist/bin.mjs");
        if (!NodeFS.existsSync(installedEntry)) {
          return yield* Effect.die(
            new Error(`npm did not install the Exowatt server entry at ${installedEntry}.`),
          );
        }
        // --help imports the complete ordinary bundle without starting a server.
        // With the old createRequire-only implementation this fails here with
        // ERR_PACKAGE_PATH_NOT_EXPORTED against npm's unpatched fff-node package.
        run(process.execPath, [installedEntry, "--help"], installRoot);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempRoot, { recursive: true, force: true })),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);
