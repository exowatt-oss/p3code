import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkPiProviderStatus } from "@t3tools/provider-pi/server";
import { PHI_PROVIDER_FLAVOR, withPhiRecommendation } from "./PhiDriver.ts";

const encoder = new TextEncoder();

function phiProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const versionProbe =
      ChildProcess.isStandardCommand(command) && command.args.includes("--version");
    const output = (value: string) => Stream.succeed(encoder.encode(value));
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_002),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(versionProbe ? 0 : 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: versionProbe ? output(`phi ${version}\n`) : Stream.empty,
        stderr: versionProbe ? Stream.empty : output("RPC startup failed"),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

const settings = { enabled: true, binaryPath: "phi", launchArgs: "", customModels: [] } as const;

const probe = (version: string) =>
  checkPiProviderStatus(settings, {}, undefined, PHI_PROVIDER_FLAVOR).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, phiProbeSpawner(version)),
  );

describe("PhiDriver probe", () => {
  it.effect("accepts an Exowatt build of the minimum release", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe("0.83.0-exo.56");
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.version, "0.83.0-exo.56");
      assert.equal(snapshot.displayName, "Phi");
      assert.equal(snapshot.models[0]?.name, "Phi default");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a Phi below the floor in Phi's own words", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe("0.82.4-exo.9");
      assert.equal(snapshot.status, "error");
      assert.include(snapshot.message ?? "", "Phi 0.83.0 or newer");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts a Phi version at the public baseline", () =>
    Effect.gen(function* () {
      const { message: _message, ...ready } = yield* probe("0.83.0-exo.30");
      assert.isUndefined(withPhiRecommendation(ready).message);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
