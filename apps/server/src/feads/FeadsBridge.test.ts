import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as FeadsBridge from "./FeadsBridge.ts";
import * as FeadsHttp from "./FeadsHttp.ts";
import * as FeadsService from "./FeadsService.ts";
import { AGENTWATCH_FIXTURE, ISSUES_FIXTURE, NOTIFICATIONS_FIXTURE } from "./feadsWire.fixtures.ts";

const memorySecretStore = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
    remove: () => Effect.void,
  }),
);

type Responder = (
  input: FeadsHttp.FeadsHttpRequest,
) => FeadsHttp.FeadsHttpFixture | FeadsHttp.FeadsHttpError;

const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

const healthy: Responder = (input) => {
  const path = pathOf(input.url);
  if (path.startsWith("/api/agentwatch")) return { status: 200, json: AGENTWATCH_FIXTURE };
  if (path.startsWith("/api/issues")) return { status: 200, json: ISSUES_FIXTURE };
  if (path.startsWith("/api/notifications/ack")) {
    return { status: 200, json: { ok: true, acknowledged: 1 } };
  }
  if (path.startsWith("/api/notifications")) return { status: 200, json: NOTIFICATIONS_FIXTURE };
  return { status: 404, json: null };
};

/** Mutable harness: swap `respond` mid-test to simulate outages. */
function makeHarness(options: { readonly env?: Record<string, string | undefined> } = {}) {
  const state = { respond: healthy as Responder, requests: [] as FeadsHttp.FeadsHttpRequest[] };
  const http = FeadsHttp.layerFromFixtures(
    (input) => state.respond(input),
    (input) => {
      state.requests.push(input);
    },
  );
  const service = FeadsService.layer({ env: options.env ?? { P3_FEADS_TOKEN: "fdsa_test" } }).pipe(
    Layer.provide(memorySecretStore),
    Layer.provide(http),
  );
  const layer = Layer.mergeAll(
    service,
    FeadsBridge.layer({ random: Effect.succeed(0.5) }).pipe(
      Layer.provide(http),
      Layer.provide(service),
    ),
  );
  const count = (prefix: string) =>
    state.requests.filter((request) => pathOf(request.url).startsWith(prefix)).length;
  return { state, layer, count };
}

/** Let forked fibers run through synchronous fixture responses. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
});

const advance = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(settle));

describe("FeadsBridge", () => {
  it.effect("polls all three doors on start and publishes typed snapshots", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const bridge = yield* FeadsBridge.FeadsBridge;
        const feads = yield* FeadsService.FeadsService;
        yield* settle;
        expect(harness.count("/api/agentwatch")).toBe(1);
        expect(harness.count("/api/issues")).toBe(1);
        expect(harness.count("/api/notifications?")).toBe(1);
        expect(harness.state.requests[0]).toMatchObject({ method: "GET", token: "fdsa_test" });

        const agentwatch = (yield* bridge.subscribeAgentwatch).latest;
        expect(agentwatch.available).toBe(true);
        expect(agentwatch.actor).toBe("alice-agent");
        expect(agentwatch.data?.agents.map((agent) => agent.actor)).toEqual([
          "alice-agent",
          "bob-phi",
          "idle-bot",
        ]);
        const myIssues = (yield* bridge.subscribeMyIssues).latest;
        expect(myIssues.issues.map((issue) => issue.id)).toEqual(["demo-8v0", "demo-abc"]);
        const inbox = (yield* bridge.subscribeInbox).latest;
        expect(inbox.notifications).toHaveLength(3);
        expect(inbox.unreadCount).toBe(98);
        expect(inbox.fetchedAt).not.toBeNull();

        const status = yield* feads.status;
        expect(status.actor).toBe("alice-agent");
        expect(status.lastPollAt).not.toBeNull();
        expect(status.lastError).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a 404 door degrades to available: false without failing the poll", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.state.respond = (input) =>
        pathOf(input.url).startsWith("/api/agentwatch") ||
        pathOf(input.url).startsWith("/api/issues")
          ? { status: 404, json: null }
          : healthy(input);
      yield* Effect.gen(function* () {
        const bridge = yield* FeadsBridge.FeadsBridge;
        const feads = yield* FeadsService.FeadsService;
        yield* settle;
        const agentwatch = (yield* bridge.subscribeAgentwatch).latest;
        expect(agentwatch).toMatchObject({ available: false, error: null, data: null });
        const myIssues = (yield* bridge.subscribeMyIssues).latest;
        expect(myIssues).toMatchObject({ available: false, error: null, issues: [] });
        const inbox = (yield* bridge.subscribeInbox).latest;
        expect(inbox.available).toBe(true);
        expect(inbox.notifications).toHaveLength(3);
        // Not a failure: the actor still resolved through the inbox, no error, normal cadence.
        const status = yield* feads.status;
        expect(status.lastError).toBeNull();
        expect(status.actor).toBe("alice-agent");
        yield* advance(Duration.millis(20_000));
        expect(harness.count("/api/agentwatch")).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("polls every 20 s, backs off exponentially on errors, resumes on success", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const feads = yield* FeadsService.FeadsService;
        const bridge = yield* FeadsBridge.FeadsBridge;
        yield* settle;
        expect(harness.count("/api/agentwatch")).toBe(1);

        yield* advance(Duration.millis(19_999));
        expect(harness.count("/api/agentwatch")).toBe(1);
        yield* advance(Duration.millis(1));
        expect(harness.count("/api/agentwatch")).toBe(2);

        // Outage: every door 503s. The next poll fails and the interval doubles.
        harness.state.respond = () => ({ status: 503, json: null });
        yield* advance(Duration.millis(20_000));
        expect(harness.count("/api/agentwatch")).toBe(3);
        expect((yield* feads.status).lastError).toBe("http_503");
        // Rows from the last good poll are kept for the panels.
        expect((yield* bridge.subscribeInbox).latest.notifications).toHaveLength(3);
        expect((yield* bridge.subscribeInbox).latest.error).toBe("http_503");

        yield* advance(Duration.millis(20_000));
        expect(harness.count("/api/agentwatch")).toBe(3);
        yield* advance(Duration.millis(20_000));
        expect(harness.count("/api/agentwatch")).toBe(4);

        // Second failure in a row: 80 s.
        yield* advance(Duration.millis(60_000));
        expect(harness.count("/api/agentwatch")).toBe(4);
        yield* advance(Duration.millis(20_000));
        expect(harness.count("/api/agentwatch")).toBe(5);

        // Recovery: back to 20 s and the error clears.
        harness.state.respond = healthy;
        yield* advance(Duration.millis(160_000));
        expect(harness.count("/api/agentwatch")).toBe(6);
        expect((yield* feads.status).lastError).toBeNull();
        yield* advance(Duration.millis(20_000));
        expect(harness.count("/api/agentwatch")).toBe(7);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("caps the backoff at five minutes", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.state.respond = () => ({ status: 500, json: null });
      yield* Effect.gen(function* () {
        yield* settle;
        // The start poll fails, so the retries come at 40, 80, 160 s and then
        // every 300 s: 1 + 3 polls after 280 s.
        for (const delay of [40_000, 80_000, 160_000]) {
          yield* advance(Duration.millis(delay));
        }
        expect(harness.count("/api/agentwatch")).toBe(4);
        yield* advance(Duration.millis(299_999));
        expect(harness.count("/api/agentwatch")).toBe(4);
        yield* advance(Duration.millis(1));
        expect(harness.count("/api/agentwatch")).toBe(5);
        yield* advance(Duration.millis(300_000));
        expect(harness.count("/api/agentwatch")).toBe(6);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("transport errors are redacted and do not drop the last good rows", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const bridge = yield* FeadsBridge.FeadsBridge;
        yield* settle;
        harness.state.respond = (input) =>
          new FeadsHttp.FeadsHttpError({
            url: input.url,
            reason: "network",
            detail: "ECONNRESET while sending fdsa_test",
          });
        yield* bridge.pollOnce;
        const inbox = (yield* bridge.subscribeInbox).latest;
        expect(inbox.notifications).toHaveLength(3);
        expect(inbox.error).toBe("network: ECONNRESET while sending fdsa_…");
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("idles while unconfigured and starts polling when a token is saved", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ env: {} });
      yield* Effect.gen(function* () {
        const feads = yield* FeadsService.FeadsService;
        const bridge = yield* FeadsBridge.FeadsBridge;
        yield* settle;
        yield* advance(Duration.minutes(10));
        expect(harness.state.requests).toHaveLength(0);
        expect((yield* bridge.subscribeAgentwatch).latest.fetchedAt).toBeNull();

        yield* feads.configure({ token: "fdsa_new" });
        yield* settle;
        expect(harness.count("/api/agentwatch")).toBe(1);
        expect(harness.state.requests[0]?.token).toBe("fdsa_new");

        // Clearing stops the loop and empties what clients see.
        yield* feads.clear();
        yield* settle;
        expect((yield* bridge.subscribeInbox).latest).toMatchObject({
          fetchedAt: null,
          notifications: [],
        });
        yield* advance(Duration.minutes(10));
        expect(harness.count("/api/agentwatch")).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ack posts the same JSON, removes the rows at once, and refreshes", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const bridge = yield* FeadsBridge.FeadsBridge;
        yield* settle;
        const before = harness.count("/api/notifications?");

        const result = yield* bridge.ackNotifications({ ids: ["n_demo_one"] });
        expect(result).toEqual({ ok: true, count: 1 });
        const ack = harness.state.requests.find((request) => request.method === "POST");
        expect(ack).toMatchObject({
          url: "http://127.0.0.1:3000/api/notifications/ack",
          token: "fdsa_test",
          body: { ids: ["n_demo_one"] },
        });
        // Optimistic removal is visible before the refresh lands...
        yield* settle;
        // ...and the refresh happened straight away, not on the 20 s tick.
        expect(harness.count("/api/notifications?")).toBe(before + 1);

        yield* bridge.ackNotifications({ all: true });
        const ackAll = harness.state.requests.findLast((request) => request.method === "POST");
        expect(ackAll?.body).toEqual({ all: true });
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ack surfaces refusals and empty requests as ExowattFeadsError", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const bridge = yield* FeadsBridge.FeadsBridge;
        yield* settle;
        const empty = yield* bridge.ackNotifications({}).pipe(Effect.flip);
        expect(empty.reason).toBe("nothing_to_ack");

        harness.state.respond = () => ({ status: 401, json: { ok: false } });
        const refused = yield* bridge.ackNotifications({ ids: ["x"] }).pipe(Effect.flip);
        expect(refused._tag).toBe("ExowattFeadsError");
        expect(refused.reason).toBe("not_identified");
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("optimistic ack removes only the acknowledged rows", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const bridge = yield* FeadsBridge.FeadsBridge;
        yield* settle;
        // Freeze the inbox door so the refresh cannot repopulate it.
        harness.state.respond = (input) =>
          pathOf(input.url).startsWith("/api/notifications?")
            ? { status: 503, json: null }
            : healthy(input);
        yield* bridge.ackNotifications({ ids: ["n_demo_one", "missing-id"] });
        yield* settle;
        const inbox = (yield* bridge.subscribeInbox).latest;
        expect(inbox.notifications.map((row) => row.id)).toEqual(["n_mention", "n_weird"]);
        expect(inbox.unreadCount).toBe(97);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
