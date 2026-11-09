// @effect-diagnostics nodeBuiltinImport:off - the pack suite verifies the real archive with node's zlib/crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EXOWATT_P3_SERVER_COMPAT } from "@t3tools/shared/exowatt";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildExowattRemoteServerPackageJson,
  EXOWATT_REMOTE_SERVER_EXTRA_RESOURCE,
  EXOWATT_REMOTE_SERVER_FILE_EXCLUSIONS,
  resolveExowattRemoteServerPackageFileName,
  stageExowattRemoteServerPackage,
} from "./exowatt-remote-server-package.ts";

describe("exowatt remote server package", () => {
  it("ships the tarball as an extra resource and keeps it out of app.asar", () => {
    assert.deepStrictEqual(EXOWATT_REMOTE_SERVER_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/p3-server",
      to: "p3-server",
    });
    assert.deepStrictEqual(EXOWATT_REMOTE_SERVER_FILE_EXCLUSIONS, [
      "!apps/desktop/prod-resources/p3-server",
      "!apps/desktop/prod-resources/p3-server/**/*",
    ]);
    assert.equal(resolveExowattRemoteServerPackageFileName("0.0.37"), "t3-0.0.37.tgz");
  });

  it("writes a publishable manifest pinned to the release version", () => {
    const manifest = buildExowattRemoteServerPackageJson({
      version: "0.0.37",
      dependencies: {
        effect: "4.0.5",
        "node-pty": "^1.2.0-beta.15",
        "@t3tools/provider-pi": "workspace:*",
      },
      overrides: {
        "@ai-sdk/provider": "2.0.0",
        // pnpm-only selector: npm pack rejects it as an invalid package name.
        "@anthropic-ai/claude-agent-sdk>@anthropic-ai/claude-agent-sdk-darwin-arm64": "-",
      },
    });
    assert.equal(manifest.name, "t3");
    assert.equal(manifest.version, "0.0.37");
    assert.deepStrictEqual(manifest.bin, { t3: "./dist/bin.mjs" });
    assert.include(manifest.files, "dist");
    // The bundle inlines everything but the CLI runtime externals; a bundled
    // `workspace:*` provider package would make the remote npm install fail.
    assert.deepStrictEqual(manifest.dependencies, { "node-pty": "^1.2.0-beta.15" });
    assert.deepStrictEqual(manifest.overrides, { "@ai-sdk/provider": "2.0.0" });
    assert.notInclude(Object.keys(manifest), "devDependencies");
    // apps/server/src/cloud/exowattP3Server.ts keys off this exact field.
    assert.strictEqual(manifest.exowattP3Server, true);
    // The remote probe keys server selection off this token, not the version.
    assert.strictEqual(manifest.exowattP3Compat, EXOWATT_P3_SERVER_COMPAT);
  });

  it.effect("packs the server dist with npm and records a matching sha256 sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "p3-pack-test-" });
      const serverDistDir = path.join(root, "server-dist");
      yield* fs.makeDirectory(serverDistDir, { recursive: true });
      yield* fs.writeFileString(path.join(serverDistDir, "bin.mjs"), "console.log('p3');\n");
      const stageResourcesDir = path.join(root, "resources");

      const result = yield* stageExowattRemoteServerPackage({
        serverDistDir,
        stageResourcesDir,
        version: "0.0.37",
        dependencies: {},
        overrides: {},
      });

      assert.equal(result.archiveName, "t3-0.0.37.tgz");
      assert.equal(result.archivePath, path.join(stageResourcesDir, "p3-server", "t3-0.0.37.tgz"));
      const bytes = yield* fs.readFile(result.archivePath);
      assert.equal(bytes.byteLength, result.bytes);
      assert.equal(NodeCrypto.createHash("sha256").update(bytes).digest("hex"), result.sha256);
      const sidecar = yield* fs.readFileString(`${result.archivePath}.sha256`);
      assert.equal(sidecar, `${result.sha256}  t3-0.0.37.tgz\n`);

      // npm pack roots every entry under package/; the manifest and dist ship.
      const tar = NodeZlib.gunzipSync(bytes).toString("latin1");
      assert.include(tar, "package/package.json");
      assert.include(tar, "package/dist/bin.mjs");
      assert.include(tar, '"version": "0.0.37"');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
