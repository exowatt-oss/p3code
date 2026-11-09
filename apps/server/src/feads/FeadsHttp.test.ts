import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as FeadsHttp from "./FeadsHttp.ts";

interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const layerCapture = (sent: Array<SentRequest>) =>
  FeadsHttp.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            sent.push({
              method: request.method,
              url: request.url,
              headers: request.headers,
              body:
                request.body._tag === "Uint8Array"
                  ? JSON.parse(new TextDecoder().decode(request.body.body))
                  : null,
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Retry-After": "5" },
              }),
            );
          }),
        ),
      ),
    ),
  );

describe("FeadsHttp", () => {
  it.effect("sends PUT and DELETE with the bearer token and a JSON body", () =>
    Effect.gen(function* () {
      const sent: Array<SentRequest> = [];
      yield* Effect.gen(function* () {
        const http = yield* FeadsHttp.FeadsHttpClient;
        const url = "https://feads.example/api/runtime-presence";
        const put = yield* http.request({
          method: "PUT",
          url,
          token: "fdsa_test",
          body: { version: 1, rows: [] },
        });
        yield* http.request({
          method: "DELETE",
          url,
          token: "fdsa_test",
          body: { runtime_id: "p3-a" },
        });

        expect(put).toMatchObject({ status: 200, json: { ok: true } });
        expect(put.headers["retry-after"]).toBe("5");
        expect(
          sent.map(({ method, url: sentUrl, body }) => ({ method, url: sentUrl, body })),
        ).toEqual([
          { method: "PUT", url, body: { version: 1, rows: [] } },
          { method: "DELETE", url, body: { runtime_id: "p3-a" } },
        ]);
        for (const request of sent) {
          expect(request.headers.authorization).toBe("Bearer fdsa_test");
          expect(request.headers["content-type"]).toContain("application/json");
        }
      }).pipe(Effect.provide(layerCapture(sent)));
    }),
  );
});
