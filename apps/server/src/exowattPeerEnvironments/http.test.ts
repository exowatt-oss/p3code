import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Etag from "effect/http/Etag";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerEnvironmentsHttp from "./http.ts";
import * as PeerEnvironments from "./PeerEnvironments.ts";

const TOKEN = "peer-bearer-token-secret";
const LINK = {
  environmentId: "environment-devbox",
  label: "devbox",
  httpBaseUrl: "http://127.0.0.1:4100",
  token: TOKEN,
  expiresAt: "2026-12-01T00:00:00.000Z",
};

class PeerEnvironmentsTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.exowattPeerEnvironments,
) {}

// The caller's scopes come from a test header; real authentication is AuthHttp's concern.
const layerFakeAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: "session-desktop" as never,
        subject: "desktop",
        method: "bearer" as never,
        scopes: new Set(
          (request.headers["x-test-scopes"] ?? "").split(",") as Array<AuthEnvironmentScope>,
        ),
      }),
    ),
  ),
);

const makeRoutes = (enabled: boolean) => {
  const secrets = new Map<string, Uint8Array>();
  return HttpApiBuilder.layer(PeerEnvironmentsTestApi).pipe(
    Layer.provide(PeerEnvironmentsHttp.layer),
    Layer.provide(layerFakeAuth),
    Layer.provide(PeerEnvironments.layer),
    Layer.provide([
      ServerSettings.layerTest({ exowattCrossEnvironmentAgentTools: enabled }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("no peer calls here")),
      ),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
        set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        remove: (name) => Effect.sync(() => void secrets.delete(name)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-mac")),
      }),
      // PeerEnvironments reads only `baseDir`.
      Layer.succeed(ServerConfig.ServerConfig, { baseDir: "/home/me/.t3" } as never),
    ]),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provideMerge(NodeServices.layer),
  );
};

const withHandler = async (
  enabled: boolean,
  body: (
    request: (method: string, path: string, scopes: string, payload?: unknown) => Promise<Response>,
  ) => Promise<void>,
) => {
  const { handler, dispose } = HttpRouter.toWebHandler(makeRoutes(enabled), {
    disableLogger: true,
  });
  const request = (method: string, path: string, scopes: string, payload?: unknown) =>
    handler(
      new Request(`http://127.0.0.1:3773${path}`, {
        method,
        headers: { "content-type": "application/json", "x-test-scopes": scopes },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
    );
  try {
    await body(request);
  } finally {
    await dispose();
  }
};

describe("/api/exowatt/peer-environments", () => {
  it("requires access:write and never returns the token", () =>
    withHandler(true, async (request) => {
      const path = "/api/exowatt/peer-environments";
      for (const [method, payload] of [
        ["GET", undefined],
        ["PUT", LINK],
      ] as const) {
        const refused = await request(method, path, AuthOrchestrationOperateScope, payload);
        expect(refused.status).toBe(403);
      }
      const removeRefused = await request(
        "DELETE",
        `${path}/environment-devbox`,
        AuthOrchestrationOperateScope,
      );
      expect(removeRefused.status).toBe(403);

      const put = await request("PUT", path, AuthAccessWriteScope, LINK);
      expect(put.status).toBe(200);
      const putText = await put.text();
      expect(putText).not.toContain(TOKEN);
      expect(JSON.parse(putText)).toMatchObject({ environmentId: "environment-devbox" });

      const list = await request("GET", path, AuthAccessWriteScope);
      expect(list.status).toBe(200);
      const listText = await list.text();
      expect(listText).not.toContain(TOKEN);
      expect(JSON.parse(listText)).toMatchObject({
        enabled: true,
        links: [{ environmentId: "environment-devbox", label: "devbox", lastError: null }],
      });

      const removed = await request("DELETE", `${path}/environment-devbox`, AuthAccessWriteScope);
      expect(await removed.json()).toEqual({ removed: true });
    }));

  it("refuses an invalid URL and refuses to link while the setting is off", async () => {
    await withHandler(true, async (request) => {
      const invalid = await request("PUT", "/api/exowatt/peer-environments", AuthAccessWriteScope, {
        ...LINK,
        httpBaseUrl: "http://user:secret@127.0.0.1:4100",
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("username or password");
    });
    await withHandler(false, async (request) => {
      const off = await request(
        "PUT",
        "/api/exowatt/peer-environments",
        AuthAccessWriteScope,
        LINK,
      );
      expect(off.status).toBe(409);
      expect(await off.text()).toContain("Settings › Sharing & access");
    });
  });
});
