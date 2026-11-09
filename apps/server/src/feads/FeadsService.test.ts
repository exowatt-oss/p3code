import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  decodeFeadsStoredConfig,
  encodeFeadsStoredConfig,
  FEADS_CONFIG_SECRET,
} from "./FeadsConfig.ts";
import * as FeadsHttp from "./FeadsHttp.ts";
import * as FeadsService from "./FeadsService.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

function makeMemorySecretStore(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, Uint8Array>(
    Object.entries(initial).map(([name, value]) => [name, encode(value)]),
  );
  const layer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.sync(() => {
          const value = values.get(name);
          return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
        }),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = values.get(name);
          if (existing) return Uint8Array.from(existing);
          const generated = new Uint8Array(bytes);
          values.set(name, generated);
          return generated;
        }),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
    }),
  );
  return { layer, values };
}

const identityOk = (actor: string): FeadsHttp.FeadsHttpFixture => ({
  status: 200,
  json: { ok: true, actor, notifications: [], unread_count: 0 },
});

function makeLayer(options: {
  readonly secrets?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly respond?: (input: FeadsHttp.FeadsHttpRequest) => FeadsHttp.FeadsHttpFixture;
  readonly requests?: FeadsHttp.FeadsHttpRequest[];
}) {
  const store = makeMemorySecretStore(options.secrets);
  const http = FeadsHttp.layerFromFixtures(
    options.respond ?? (() => identityOk("someone")),
    (input) => options.requests?.push(input),
  );
  return {
    layer: FeadsService.layer({ env: options.env ?? {} }).pipe(
      Layer.provide(store.layer),
      Layer.provide(http),
    ),
    store,
  };
}

describe("FeadsService", () => {
  it.effect("starts unconfigured and reports the default server", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      const status = yield* feads.status;
      expect(status).toEqual({
        configured: false,
        baseUrl: "http://127.0.0.1:3000",
        actor: null,
        defaultBoard: null,
        lastPollAt: null,
        lastError: null,
        tokenSource: "none",
      });
      expect(yield* feads.test()).toEqual({ ok: false, actor: null, error: "not_configured" });
    }).pipe(Effect.provide(makeLayer({}).layer)),
  );

  it.effect("stores the token in the secret store and never in the status", () =>
    Effect.gen(function* () {
      const { layer, store } = makeLayer({});
      yield* Effect.gen(function* () {
        const feads = yield* FeadsService.FeadsService;
        const status = yield* feads.configure({
          token: " fdsa_secret ",
          baseUrl: "feads.example/",
          defaultBoard: "demo",
        });
        expect(status.configured).toBe(true);
        expect(status.tokenSource).toBe("settings");
        expect(status.baseUrl).toBe("https://feads.example");
        expect(status.defaultBoard).toBe("demo");
        // The status is flat, so a join over its values is a full text scan for the token.
        expect(Object.values(status).join("|")).not.toContain("fdsa_");

        const resolved = yield* feads.resolvedConfig;
        expect(resolved.token).toBe("fdsa_secret");
      }).pipe(Effect.provide(layer));

      const persisted = store.values.get(FEADS_CONFIG_SECRET);
      expect(persisted).toBeDefined();
      expect(Option.getOrThrow(decodeFeadsStoredConfig(decode(persisted!)))).toEqual({
        token: "fdsa_secret",
        baseUrl: "https://feads.example",
        defaultBoard: "demo",
      });
    }),
  );

  it.effect("loads a previously stored configuration on start", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      const status = yield* feads.status;
      expect(status.configured).toBe(true);
      expect(status.baseUrl).toBe("https://feads.stored");
      expect(status.defaultBoard).toBe("ia");
    }).pipe(
      Effect.provide(
        makeLayer({
          secrets: {
            [FEADS_CONFIG_SECRET]: encodeFeadsStoredConfig({
              token: "fdsa_old",
              baseUrl: "https://feads.stored",
              defaultBoard: "ia",
            }),
          },
        }).layer,
      ),
    ),
  );

  it.effect("refuses an empty token or a non-http server", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      const empty = yield* feads.configure({ token: "   " }).pipe(Effect.flip);
      expect(empty._tag).toBe("ExowattFeadsError");
      expect(empty.reason).toContain("empty");
      const badUrl = yield* feads.configure({ baseUrl: "ftp://x" }).pipe(Effect.flip);
      expect(badUrl.reason).toContain("http(s)");
      expect((yield* feads.status).configured).toBe(false);
    }).pipe(Effect.provide(makeLayer({}).layer)),
  );

  it.effect("test() resolves the actor through the identity probe and records failures", () =>
    Effect.gen(function* () {
      const requests: FeadsHttp.FeadsHttpRequest[] = [];
      let answer: FeadsHttp.FeadsHttpFixture = identityOk("alice-agent");
      const { layer } = makeLayer({
        env: { P3_FEADS_TOKEN: "fdsa_env" },
        respond: () => answer,
        requests,
      });
      yield* Effect.gen(function* () {
        const feads = yield* FeadsService.FeadsService;
        expect((yield* feads.status).tokenSource).toBe("environment");

        expect(yield* feads.test()).toEqual({ ok: true, actor: "alice-agent", error: null });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          method: "GET",
          url: "http://127.0.0.1:3000/api/notifications?unread_only=1&limit=1",
          token: "fdsa_env",
        });
        expect((yield* feads.status).actor).toBe("alice-agent");

        answer = { status: 401, json: { ok: false, error: "not_identified" } };
        expect(yield* feads.test()).toEqual({ ok: false, actor: null, error: "not_identified" });
        const after = yield* feads.status;
        // The last good identity stays visible; the error is reported beside it.
        expect(after.actor).toBe("alice-agent");
        expect(after.lastError).toBe("not_identified");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("turns transport failures into a redacted error string", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      const result = yield* feads.test();
      expect(result.ok).toBe(false);
      expect(result.error).toBe("network: socket hang up for fdsa_…");
    }).pipe(
      Effect.provide(
        FeadsService.layer({ env: { P3_FEADS_TOKEN: "fdsa_env" } }).pipe(
          Layer.provide(makeMemorySecretStore().layer),
          Layer.provide(
            FeadsHttp.layerFromFixtures(
              (input) =>
                new FeadsHttp.FeadsHttpError({
                  url: input.url,
                  reason: "network",
                  detail: "socket hang up for fdsa_env",
                }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("does not let Settings replace a token that came from the environment", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      const error = yield* feads.configure({ token: "fdsa_new" }).pipe(Effect.flip);
      expect(error.reason).toContain("P3_FEADS_TOKEN");
      // The server and board are still editable alongside an environment token.
      const status = yield* feads.configure({ defaultBoard: "demo" });
      expect(status.defaultBoard).toBe("demo");
      expect(status.tokenSource).toBe("environment");
    }).pipe(Effect.provide(makeLayer({ env: { P3_FEADS_TOKEN: "fdsa_env" } }).layer)),
  );

  it.effect("clear() removes the secret and resets the status", () =>
    Effect.gen(function* () {
      const { layer, store } = makeLayer({});
      yield* Effect.gen(function* () {
        const feads = yield* FeadsService.FeadsService;
        yield* feads.configure({ token: "fdsa_secret", defaultBoard: "demo" });
        yield* feads.test();
        expect((yield* feads.status).actor).toBe("someone");
        const status = yield* feads.clear();
        expect(status).toMatchObject({
          configured: false,
          actor: null,
          defaultBoard: null,
          lastError: null,
          tokenSource: "none",
        });
      }).pipe(Effect.provide(layer));
      expect(store.values.has(FEADS_CONFIG_SECRET)).toBe(false);
    }),
  );

  it.effect("a new token or server forgets the previously resolved actor", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      yield* feads.configure({ token: "fdsa_a" });
      yield* feads.test();
      expect((yield* feads.status).actor).toBe("someone");
      // Same token again: nothing changes.
      expect((yield* feads.configure({ token: "fdsa_a" })).actor).toBe("someone");
      expect((yield* feads.configure({ token: "fdsa_b" })).actor).toBeNull();
      yield* feads.test();
      expect((yield* feads.configure({ baseUrl: "https://feads.elsewhere" })).actor).toBeNull();
    }).pipe(Effect.provide(makeLayer({}).layer)),
  );

  it.effect("subscribers get the current status first and every change after", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      const { latest, changes } = yield* feads.subscribeStatus;
      expect(latest.configured).toBe(false);
      const collected = yield* Stream.take(changes, 3).pipe(Stream.runCollect, Effect.forkChild);
      // The status PubSub keeps only the newest snapshot for a slow subscriber
      // (that is the point for clients), so let the collector drain between steps.
      yield* Effect.yieldNow;
      yield* feads.configure({ token: "fdsa_a" });
      yield* Effect.yieldNow;
      yield* feads.test();
      yield* Effect.yieldNow;
      yield* feads.recordPoll({ error: "http_503" });
      const emitted = Array.from(yield* Fiber.join(collected));
      expect(emitted.map((status) => status.configured)).toEqual([true, true, true]);
      expect(emitted[1]?.actor).toBe("someone");
      expect(emitted[2]?.lastError).toBe("http_503");
      expect(emitted[2]?.lastPollAt).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(makeLayer({}).layer)),
  );

  it.effect("subscribeConfig hands the poller the current config, then each change", () =>
    Effect.gen(function* () {
      const feads = yield* FeadsService.FeadsService;
      const { latest, changes } = yield* feads.subscribeConfig;
      expect(latest.token).toBeNull();
      const collected = yield* Stream.take(changes, 2).pipe(Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* feads.configure({ token: "fdsa_a", baseUrl: "https://feads.one" });
      yield* Effect.yieldNow;
      yield* feads.clear();
      const emitted = Array.from(yield* Fiber.join(collected));
      expect(emitted.map((config) => [config.token, config.baseUrl])).toEqual([
        ["fdsa_a", "https://feads.one"],
        [null, "http://127.0.0.1:3000"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(makeLayer({}).layer)),
  );
});
