// @effect-diagnostics nodeBuiltinImport:off - exercises the synchronous manifest lookup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

import {
  detectExowattP3Server,
  EXOWATT_P3_SERVER_ENV,
  EXOWATT_P3_SERVER_MANIFEST_KEY,
  exowattP3ServerRefusalReason,
  readExowattServerManifest,
  resolveExowattServerManifestPath,
} from "./exowattP3Server.ts";

describe("exowattP3Server", () => {
  it("is off for upstream and dev builds (no marker, no env)", () => {
    assert.deepStrictEqual(detectExowattP3Server({ env: {}, manifest: undefined }), {
      p3Server: false,
      source: "none",
    });
    assert.deepStrictEqual(
      detectExowattP3Server({ env: {}, manifest: { name: "t3", version: "0.0.37" } }),
      { p3Server: false, source: "none" },
    );
    assert.deepStrictEqual(
      detectExowattP3Server({ env: {}, manifest: { [EXOWATT_P3_SERVER_MANIFEST_KEY]: "yes" } }),
      { p3Server: false, source: "none" },
    );
  });

  it("is on when the P3 tarball manifest carries the marker", () => {
    assert.deepStrictEqual(
      detectExowattP3Server({
        env: {},
        manifest: { name: "t3", [EXOWATT_P3_SERVER_MANIFEST_KEY]: true },
      }),
      { p3Server: true, source: "manifest" },
    );
  });

  it("lets EXOWATT_P3_SERVER override the manifest either way", () => {
    assert.deepStrictEqual(
      detectExowattP3Server({ env: { [EXOWATT_P3_SERVER_ENV]: "1" }, manifest: undefined }),
      { p3Server: true, source: "env" },
    );
    assert.deepStrictEqual(
      detectExowattP3Server({ env: { [EXOWATT_P3_SERVER_ENV]: " TRUE " }, manifest: undefined }),
      { p3Server: true, source: "env" },
    );
    assert.deepStrictEqual(
      detectExowattP3Server({
        env: { [EXOWATT_P3_SERVER_ENV]: "0" },
        manifest: { [EXOWATT_P3_SERVER_MANIFEST_KEY]: true },
      }),
      { p3Server: false, source: "env" },
    );
    // Anything else is ignored, not treated as truthy.
    assert.deepStrictEqual(
      detectExowattP3Server({ env: { [EXOWATT_P3_SERVER_ENV]: "maybe" }, manifest: undefined }),
      { p3Server: false, source: "none" },
    );
  });

  it("resolves the manifest one directory above the bundle and tolerates a missing file", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "p3-manifest-"));
    try {
      const distDir = NodePath.join(root, "node_modules", "t3", "dist");
      NodeFS.mkdirSync(distDir, { recursive: true });
      const moduleUrl = NodeURL.pathToFileURL(NodePath.join(distDir, "bin.mjs")).href;
      const manifestPath = resolveExowattServerManifestPath(moduleUrl);
      assert.equal(manifestPath, NodePath.join(root, "node_modules", "t3", "package.json"));
      assert.isUndefined(readExowattServerManifest(manifestPath));
      NodeFS.writeFileSync(manifestPath, "{ not json");
      assert.isUndefined(readExowattServerManifest(manifestPath));
      NodeFS.writeFileSync(manifestPath, `{"name":"t3","${EXOWATT_P3_SERVER_MANIFEST_KEY}":true}`);
      assert.deepStrictEqual(readExowattServerManifest(manifestPath), {
        name: "t3",
        [EXOWATT_P3_SERVER_MANIFEST_KEY]: true,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the target version and the signal in the refusal reason", () => {
    const fromManifest = exowattP3ServerRefusalReason("0.0.38", {
      p3Server: true,
      source: "manifest",
    });
    assert.include(fromManifest, "t3@0.0.38");
    assert.include(fromManifest, EXOWATT_P3_SERVER_MANIFEST_KEY);
    assert.include(fromManifest, "Phi");
    assert.include(
      exowattP3ServerRefusalReason("0.0.38", { p3Server: true, source: "env" }),
      `${EXOWATT_P3_SERVER_ENV} is set`,
    );
  });
});
