import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  ensureSshEnvironment,
  DesktopSshEnvironmentRequestError,
  fetchSshEnvironmentDescriptor,
} from "./sshEnvironment.ts";

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("SSH environment IPC", () => {
  it.effect("rejects non-loopback HTTP endpoints before issuing a request", () => {
    let requestCount = 0;
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {});
      }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://remote.example.com:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.instanceOf(error.cause, SshHttpBridgeError);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });
});

describe("SSH health-check preference", () => {
  it.effect("reads saved settings on each connect and defaults to five seconds", () => {
    const timeouts: Array<number | undefined> = [];
    const ssh = DesktopSshEnvironment.DesktopSshEnvironment.of({
      runRemoteOperation: () => Effect.die("Unexpected remote operation"),
      discoverHosts: () => Effect.succeed([]),
      resolveHost: () => Effect.die("Unexpected SSH host resolution"),
      disconnectEnvironment: () => Effect.void,
      ensureEnvironment: (target, options) =>
        Effect.sync(() => {
          timeouts.push(options?.probeTimeoutMs);
          assert.isTrue(options?.issuePairingToken);
          return {
            target,
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
            pairingToken: "test",
          };
        }),
    });
    return Effect.gen(function* () {
      const settings = yield* DesktopClientSettings.DesktopClientSettings;
      const input = {
        target: { alias: "vm", hostname: "vm", username: "dev", port: 22 },
        options: { issuePairingToken: true },
      };
      yield* ensureSshEnvironment.handler(input);
      yield* settings.set({ ...DEFAULT_CLIENT_SETTINGS, remoteHealthCheckTimeoutSeconds: 10 });
      yield* ensureSshEnvironment.handler(input);
      yield* settings.set(DEFAULT_CLIENT_SETTINGS);
      yield* ensureSshEnvironment.handler(input);
      assert.deepEqual(timeouts, [5_000, 10_000, 5_000]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          DesktopClientSettings.layerTest(),
          Layer.succeed(DesktopSshEnvironment.DesktopSshEnvironment, ssh),
        ),
      ),
    );
  });
});
