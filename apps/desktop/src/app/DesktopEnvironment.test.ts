import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/P3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/P3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  // exowatt: the desktop identity is P3 Code in development and production.
  it.effect("carries the P3 Code identity in development and production", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { T3CODE_HOME: "/tmp/t3", VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      assert.equal(development.branding.baseName, "P3 Code");
      assert.equal(development.displayName, "P3 Code (Dev)");
      assert.equal(development.appUserModelId, "com.exowatt.p3code.dev");

      const production = yield* makeEnvironment({}, { T3CODE_HOME: "/tmp/t3" });
      assert.equal(production.branding.baseName, "P3 Code");
      assert.equal(production.displayName, "P3 Code (Beta)");
      assert.equal(production.appUserModelId, "com.exowatt.p3code");
    }),
  );

  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
    }),
  );
});
