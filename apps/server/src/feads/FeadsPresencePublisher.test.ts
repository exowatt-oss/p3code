import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as FeadsHttp from "./FeadsHttp.ts";
import * as FeadsPresencePublisher from "./FeadsPresencePublisher.ts";
import * as FeadsService from "./FeadsService.ts";

const ROW_KEYS = [
  "activity",
  "client",
  "context_percent",
  "display_name",
  "handle",
  "kind",
  "model",
  "parent_run_id",
  "run_id",
  "runtime_id",
  "session_id",
  "started_at",
  "status",
].toSorted();

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

interface PresenceBody {
  readonly version: number;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

type Responder = (
  input: FeadsHttp.FeadsHttpRequest,
) => FeadsHttp.FeadsHttpFixture | FeadsHttp.FeadsHttpError;

const accepted: Responder = () => ({ status: 200, json: { ok: true } });

const createdAt = DateTime.makeUnsafe("2026-10-22T10:00:00.000Z");

const makeHarness = Effect.fn("makeHarness")(function* (
  options: { readonly env?: Record<string, string | undefined> } = {},
) {
  const state = {
    respond: accepted,
    requests: [] as FeadsHttp.FeadsHttpRequest[],
  };
  const env = options.env ?? { P3_FEADS_TOKEN: "fdsa_test" };
  const http = FeadsHttp.layerFromFixtures(
    (input) => state.respond(input),
    (input) => {
      state.requests.push(input);
    },
  );
  const service = FeadsService.layer({ env }).pipe(
    Layer.provide(memorySecretStore),
    Layer.provide(http),
  );
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const dependencies = Layer.mergeAll(
    service,
    http,
    NodeCrypto.layer,
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-test")),
    }),
  );
  const layer = Layer.mergeAll(
    service,
    FeadsPresencePublisher.layer({ env, random: Effect.succeed(0.5) }).pipe(
      Layer.provide(dependencies),
    ),
  );
  const puts = () =>
    state.requests
      .filter((request) => request.method === "PUT")
      .map((request) => request.body as PresenceBody);
  const deletes = () =>
    state.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.body as { readonly runtime_id: string });
  const emit = (event: OrchestrationV2DomainEvent) => Queue.offer(events, event);
  return { state, layer, puts, deletes, emit };
});

/** Let forked fibers run through synchronous fixture responses. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
});

const advance = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(settle));

/** Past the debounce, so a burst of changes has been sent. */
const flush = advance(Duration.millis(FeadsPresencePublisher.FEADS_PRESENCE_DEBOUNCE_MS));

let eventSequence = 0;
const nextEventId = () => EventId.make(`event:presence:${(eventSequence += 1)}`);

function session(
  options: {
    readonly id?: string;
    readonly driver?: string;
    readonly status?: OrchestrationV2ProviderSession["status"];
    readonly model?: string | null;
  } = {},
): OrchestrationV2ProviderSession {
  const driver = ProviderDriverKind.make(options.driver ?? "codex");
  return {
    id: ProviderSessionId.make(options.id ?? "provider-session-a"),
    driver,
    providerInstanceId: ProviderInstanceId.make(options.driver ?? "codex"),
    status: options.status ?? "ready",
    cwd: "/repo",
    model: options.model === undefined ? "gpt-5.5" : options.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt,
    updatedAt: createdAt,
    lastError: null,
  };
}

const sessionEvent = (
  threadId: string,
  payload: OrchestrationV2ProviderSession,
  type: "provider-session.attached" | "provider-session.updated" = "provider-session.attached",
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type,
  threadId: ThreadId.make(threadId),
  driver: payload.driver,
  occurredAt: createdAt,
  payload,
});

const detachEvent = (threadId: string, providerSessionId: string): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type: "provider-session.detached",
  threadId: ThreadId.make(threadId),
  occurredAt: createdAt,
  payload: { providerSessionId: ProviderSessionId.make(providerSessionId), detachedAt: createdAt },
});

// The publisher reads only id, threadId, status and modelSelection off a run.
const runEvent = (
  threadId: string,
  status: "running" | "completed",
  model = "gpt-5.5",
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type: "run.updated",
  threadId: ThreadId.make(threadId),
  occurredAt: createdAt,
  payload: {
    id: RunId.make(`run:${threadId}`),
    threadId: ThreadId.make(threadId),
    status,
    modelSelection: { instanceId: "codex", model },
  } as never,
});

// ...and only type, id, threadId, status and the tool name off a turn item.
const toolEvent = (
  threadId: string,
  status: "running" | "completed",
  toolName: string | null,
): OrchestrationV2DomainEvent => ({
  id: nextEventId(),
  type: "turn-item.updated",
  threadId: ThreadId.make(threadId),
  occurredAt: createdAt,
  payload: {
    id: TurnItemId.make(`item:${threadId}`),
    threadId: ThreadId.make(threadId),
    type: "dynamic_tool",
    status,
    toolName,
    input: { path: "/Users/someone/secret.txt" },
  } as never,
});

describe("FeadsPresencePublisher", () => {
  it.effect("publishes one main row per live codex session with exactly feads' keys", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* flush;

        const [put] = harness.puts();
        expect(harness.puts()).toHaveLength(1);
        expect(harness.state.requests[0]).toMatchObject({
          method: "PUT",
          url: "http://127.0.0.1:3000/api/runtime-presence",
          token: "fdsa_test",
        });
        expect(Object.keys(put ?? {}).toSorted()).toEqual(["rows", "version"]);
        expect(put?.version).toBe(1);
        const row = put?.rows[0] ?? {};
        expect(Object.keys(row).toSorted()).toEqual(ROW_KEYS);
        expect(row).toMatchObject({
          session_id: "thread-a",
          parent_run_id: "",
          kind: "main",
          handle: "main",
          display_name: "Codex",
          status: "idle",
          model: "gpt-5.5",
          activity: "",
          context_percent: 0,
          started_at: DateTime.toEpochMillis(createdAt),
          client: "p3",
        });
        expect(row.run_id).toBe(row.runtime_id);
        expect(row.runtime_id).toMatch(/^p3-[0-9a-f]{40}$/u);

        const feads = yield* FeadsService.FeadsService;
        expect((yield* feads.status).presence).toMatchObject({
          enabled: true,
          disabledReason: null,
          liveRows: 1,
          lastError: null,
        });
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("skips phi sessions entirely; phi publishes its own rows", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-phi", session({ driver: "phi" })));
        yield* harness.emit(runEvent("thread-phi", "running"));
        yield* harness.emit(sessionEvent("thread-claude", session({ driver: "claudeAgent" })));
        yield* flush;
        yield* advance(Duration.minutes(2));

        const sessionIds = harness.puts().flatMap((put) => put.rows.map((row) => row.session_id));
        expect(sessionIds.length).toBeGreaterThan(0);
        expect(new Set(sessionIds)).toEqual(new Set(["thread-claude"]));
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports working with a safe activity while a run is in flight, idle after", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* harness.emit(runEvent("thread-a", "running", "gpt-5.5-mini"));
        yield* flush;
        expect(harness.puts().at(-1)?.rows[0]).toMatchObject({
          status: "working",
          activity: "thinking",
          model: "gpt-5.5-mini",
        });

        yield* harness.emit(toolEvent("thread-a", "running", "read_file"));
        yield* flush;
        expect(harness.puts().at(-1)?.rows[0]).toMatchObject({ activity: "read_file" });
        // A tool name that is not a bare identifier never goes out verbatim.
        yield* harness.emit(toolEvent("thread-a", "running", "cat /etc/passwd"));
        yield* flush;
        expect(harness.puts().at(-1)?.rows[0]).toMatchObject({ activity: "tool" });
        expect(JSON.stringify(harness.puts())).not.toContain("secret.txt");

        yield* harness.emit(runEvent("thread-a", "completed"));
        yield* flush;
        expect(harness.puts().at(-1)?.rows[0]).toMatchObject({ status: "idle", activity: "" });
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("heartbeats every 30 s and deletes the row when the session stops", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* flush;
        expect(harness.puts()).toHaveLength(1);
        const runtimeId = harness.puts()[0]?.rows[0]?.runtime_id;

        yield* advance(Duration.millis(FeadsPresencePublisher.FEADS_PRESENCE_HEARTBEAT_MS - 1));
        expect(harness.puts()).toHaveLength(1);
        yield* advance(Duration.millis(1));
        expect(harness.puts()).toHaveLength(2);
        yield* advance(Duration.millis(FeadsPresencePublisher.FEADS_PRESENCE_HEARTBEAT_MS));
        expect(harness.puts()).toHaveLength(3);

        yield* harness.emit(
          sessionEvent("thread-a", session({ status: "stopped" }), "provider-session.updated"),
        );
        yield* flush;
        expect(harness.deletes()).toEqual([{ runtime_id: runtimeId }]);
        // Nothing left to keep alive.
        yield* advance(Duration.minutes(5));
        expect(harness.puts()).toHaveLength(3);
        const feads = yield* FeadsService.FeadsService;
        expect((yield* feads.status).presence?.liveRows).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("deletes on detach, and a resumed thread gets a fresh runtime id", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session({ id: "session-1" })));
        yield* flush;
        yield* harness.emit(detachEvent("thread-a", "session-1"));
        yield* harness.emit(sessionEvent("thread-a", session({ id: "session-2" })));
        yield* flush;

        const first = harness.puts()[0]?.rows[0]?.runtime_id;
        const second = harness.puts()[1]?.rows[0]?.runtime_id;
        expect(first).toBeDefined();
        expect(second).not.toBe(first);
        expect(harness.puts()[1]?.rows[0]?.session_id).toBe("thread-a");
        expect(harness.deletes()).toEqual([{ runtime_id: first }]);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retracts every row on shutdown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* harness.emit(sessionEvent("thread-b", session({ id: "provider-session-b" })));
        yield* flush;
        expect(harness.puts()[0]?.rows).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
      expect(
        harness
          .deletes()
          .map((body) => body.runtime_id)
          .toSorted(),
      ).toEqual(
        harness
          .puts()[0]
          ?.rows.map((row) => row.runtime_id)
          .toSorted(),
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("P3_FEADS_PRESENCE=0 sends nothing and says why", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        env: { P3_FEADS_TOKEN: "fdsa_test", P3_FEADS_PRESENCE: "0" },
      });
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* advance(Duration.minutes(2));
        expect(harness.state.requests).toHaveLength(0);
        const feads = yield* FeadsService.FeadsService;
        expect((yield* feads.status).presence).toMatchObject({
          enabled: false,
          disabledReason: "kill_switch",
        });
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("sends nothing without a token, then publishes once one is saved", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ env: {} });
      yield* Effect.gen(function* () {
        const feads = yield* FeadsService.FeadsService;
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* advance(Duration.minutes(2));
        expect(harness.state.requests).toHaveLength(0);
        expect((yield* feads.status).presence).toMatchObject({
          enabled: false,
          disabledReason: "not_configured",
        });

        yield* feads.configure({ token: "fdsa_new" });
        yield* flush;
        expect(harness.puts()).toHaveLength(1);
        expect(harness.state.requests[0]?.token).toBe("fdsa_new");

        // Removing the token retracts what was published with it, then goes quiet.
        yield* feads.clear();
        yield* flush;
        expect(harness.state.requests.at(-1)).toMatchObject({
          method: "DELETE",
          token: "fdsa_new",
        });
        const sent = harness.state.requests.length;
        yield* advance(Duration.minutes(5));
        expect(harness.state.requests).toHaveLength(sent);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("backs off on 400 and 401 without failing, then recovers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.state.respond = () => ({ status: 401, json: { ok: false } });
      yield* Effect.gen(function* () {
        const feads = yield* FeadsService.FeadsService;
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* flush;
        expect(harness.puts()).toHaveLength(1);
        expect((yield* feads.status).presence?.lastError).toBe("http_401");

        // Doubling from 1 s, plus half of the (pinned) jitter window: 1.5 s, 2.5 s, 4.5 s.
        yield* advance(Duration.millis(1_499));
        expect(harness.puts()).toHaveLength(1);
        yield* advance(Duration.millis(1));
        expect(harness.puts()).toHaveLength(2);
        harness.state.respond = () => ({ status: 400, json: { ok: false } });
        yield* advance(Duration.millis(2_499));
        expect(harness.puts()).toHaveLength(2);
        yield* advance(Duration.millis(1));
        expect(harness.puts()).toHaveLength(3);
        expect((yield* feads.status).presence?.lastError).toBe("http_400");

        harness.state.respond = accepted;
        yield* advance(Duration.millis(5_000));
        expect(harness.puts()).toHaveLength(4);
        expect((yield* feads.status).presence).toMatchObject({ lastError: null, liveRows: 1 });
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("honours Retry-After and survives transport errors", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.state.respond = () => ({
        status: 429,
        json: null,
        headers: { "retry-after": "20" },
      });
      yield* Effect.gen(function* () {
        yield* settle;
        yield* harness.emit(sessionEvent("thread-a", session()));
        yield* flush;
        expect(harness.puts()).toHaveLength(1);
        harness.state.respond = (input) =>
          new FeadsHttp.FeadsHttpError({ url: input.url, reason: "network", detail: "ECONNRESET" });
        yield* advance(Duration.millis(19_999));
        expect(harness.puts()).toHaveLength(1);
        yield* advance(Duration.millis(1));
        expect(harness.puts()).toHaveLength(2);
        const feads = yield* FeadsService.FeadsService;
        expect((yield* feads.status).presence?.lastError).toBe("network");
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("splits more than 64 rows into batches of at most 64", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* settle;
        for (let index = 0; index < 70; index += 1) {
          yield* harness.emit(
            sessionEvent(`thread-${index}`, session({ id: `provider-session-${index}` })),
          );
        }
        yield* flush;
        expect(harness.puts().map((put) => put.rows.length)).toEqual([64, 6]);
        expect(
          new Set(harness.puts().flatMap((put) => put.rows.map((row) => row.runtime_id))).size,
        ).toBe(70);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
