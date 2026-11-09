import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as HarnessLaunchEnvironment from "./HarnessLaunchEnvironment.ts";

// One value per denied name; BUN_OPTIONS is the one that provably hijacks the phi
// binary (BUN_OPTIONS=--preload=x.js makes `phi --version` fail before phi runs).
const DENIED_FIXTURE = {
  ELECTRON_RUN_AS_NODE: "1",
  NODE_OPTIONS: "--require bad.js",
  BUN_OPTIONS: "--preload=/definitely/missing.js",
  NODE_CHANNEL_FD: "4",
  ORIGINAL_XDG_CURRENT_DESKTOP: "electron",
  PWD: "/somewhere/else",
  OLDPWD: "/somewhere/older",
} satisfies Record<string, string>;

describe("HarnessLaunchEnvironment", () => {
  it.effect("uses the captured login environment with launch overlays winning", () =>
    Effect.gen(function* () {
      const environment = yield* HarnessLaunchEnvironment.HarnessLaunchEnvironment;

      assert.deepEqual(environment.forChild({ SHARED: "p3", P3_PHI_MCP_ENDPOINT: "local" }), {
        LOGIN_ONLY: "captured",
        SHARED: "p3",
        P3_PHI_MCP_ENDPOINT: "local",
      });
    }).pipe(
      Effect.provide(
        HarnessLaunchEnvironment.layerTest(
          { LOGIN_ONLY: "captured", SHARED: "login" },
          { FALLBACK_ONLY: "process" },
        ),
      ),
    ),
  );

  it.effect("falls back to the server process environment when no capture is available", () =>
    Effect.gen(function* () {
      const environment = yield* HarnessLaunchEnvironment.HarnessLaunchEnvironment;
      assert.deepEqual(environment.forChild(), { FALLBACK_ONLY: "process" });
    }).pipe(
      Effect.provide(HarnessLaunchEnvironment.layerTest(undefined, { FALLBACK_ONLY: "process" })),
    ),
  );

  it.effect("does not forward process-control variables from the desktop capture", () =>
    Effect.gen(function* () {
      const environment = yield* HarnessLaunchEnvironment.HarnessLaunchEnvironment;
      const child = environment.forChild();

      for (const name of HarnessLaunchEnvironment.HARNESS_ENVIRONMENT_DENYLIST) {
        assert.notProperty(child, name);
      }
      assert.equal(child.SAFE_VARIABLE, "kept");
    }).pipe(
      Effect.provide(
        HarnessLaunchEnvironment.layerTest({
          SAFE_VARIABLE: "kept",
          ...DENIED_FIXTURE,
        }),
      ),
    ),
  );

  // Regression: the desktop launches this server with ELECTRON_RUN_AS_NODE=1, so an
  // unfiltered process.env fallback (shell timeout, Windows, missing capture) would
  // forward exactly the variable the denylist exists to block.
  it.effect("applies the denylist to the process.env fallback as well", () =>
    Effect.gen(function* () {
      const environment = yield* HarnessLaunchEnvironment.HarnessLaunchEnvironment;
      const child = environment.forChild({ P3_MARKER: "overlay" });

      for (const name of HarnessLaunchEnvironment.HARNESS_ENVIRONMENT_DENYLIST) {
        assert.notProperty(child, name);
      }
      assert.deepEqual(child, { SAFE_VARIABLE: "kept", P3_MARKER: "overlay" });
    }).pipe(
      Effect.provide(
        HarnessLaunchEnvironment.layerTest(undefined, {
          SAFE_VARIABLE: "kept",
          ...DENIED_FIXTURE,
        }),
      ),
    ),
  );

  it.effect("forChild helper reads the provided service (no silent fallback)", () =>
    Effect.gen(function* () {
      const child = yield* HarnessLaunchEnvironment.forChild({ P3_MARKER: "overlay" });
      assert.deepEqual(child, { LOGIN_ONLY: "captured", P3_MARKER: "overlay" });
    }).pipe(
      Effect.provide(
        HarnessLaunchEnvironment.layerTest({ LOGIN_ONLY: "captured", BUN_OPTIONS: "--preload=x" }),
      ),
    ),
  );

  it("sanitizeHarnessEnvironment strips every denied name and nothing else", () => {
    const sanitized = HarnessLaunchEnvironment.sanitizeHarnessEnvironment({
      KEEP_ME: "1",
      BUN_PUBLIC_SOMETHING: "kept-not-wildcarded",
      ...DENIED_FIXTURE,
    });
    assert.deepEqual(sanitized, { KEEP_ME: "1", BUN_PUBLIC_SOMETHING: "kept-not-wildcarded" });
  });
});

describe("HARNESS_ENVIRONMENT_DENYLIST fixture coverage", () => {
  it("DENIED_FIXTURE names exactly the denylist", () => {
    assert.deepEqual(
      Object.keys(DENIED_FIXTURE).sort(),
      [...HarnessLaunchEnvironment.HARNESS_ENVIRONMENT_DENYLIST].sort(),
    );
  });
});
