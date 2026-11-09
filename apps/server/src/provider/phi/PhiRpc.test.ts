import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  fetchPhiLatestVersion,
  isRecommendedPhiVersion,
  isSupportedPhiVersion,
  parsePhiCliVersion,
} from "./PhiRpc.ts";

const FEED_URL = "https://phi.example.com/downloads/versions.json";

const feed = (body: unknown, status = 200) =>
  HttpClient.make((request) => {
    assert.equal(request.url, FEED_URL);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
  });

describe("Phi version policy", () => {
  it("keeps the Exowatt prerelease when parsing `phi --version`", () => {
    assert.equal(parsePhiCliVersion("phi 0.83.0-exo.56\n"), "0.83.0-exo.56");
    assert.equal(parsePhiCliVersion("0.83.0"), "0.83.0");
  });

  it("accepts every Exowatt build of the floor release", () => {
    // Plain semver ranks 0.83.0-exo.N below 0.83.0; the floor must not.
    assert.isTrue(isSupportedPhiVersion("0.83.0-exo.1"));
    assert.isTrue(isSupportedPhiVersion("0.83.0-exo.56"));
    assert.isFalse(isSupportedPhiVersion("0.82.9-exo.99"));
  });

  it("recommends the first build with session-scoped set_model", () => {
    assert.isTrue(isRecommendedPhiVersion("0.83.0-exo.34"));
    assert.isTrue(isRecommendedPhiVersion("0.83.0-exo.35"));
    assert.isTrue(isRecommendedPhiVersion("0.84.0"));
  });

  it.effect("reads the latest version from the versions feed, keeping the prerelease", () =>
    Effect.gen(function* () {
      const latest = yield* fetchPhiLatestVersion(FEED_URL).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          feed({ latest: { version: "0.83.0-exo.29", releaseId: "x" } }),
        ),
      );
      assert.equal(latest, "0.83.0-exo.29");
      const unreadable = yield* fetchPhiLatestVersion(FEED_URL).pipe(
        Effect.provideService(HttpClient.HttpClient, feed({}, 503)),
      );
      assert.isNull(unreadable);
    }),
  );
});
