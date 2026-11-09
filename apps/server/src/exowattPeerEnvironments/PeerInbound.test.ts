import {
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerGate from "./PeerGate.ts";
import * as PeerInbound from "./PeerInbound.ts";

const session = (sessionId: string, label?: string) =>
  ({
    sessionId: AuthSessionId.make(sessionId),
    client: { deviceType: "desktop", ...(label === undefined ? {} : { label }) },
  }) as never;

const ACTIVE = [
  session("peer-mac", "p3-peer:Mac (environment-mac)"),
  session("peer-reverse", "p3-peer:reverse devbox (environment-devbox)"),
  session("browser", "Chrome on Mac"),
  session("unlabelled"),
];

const PEER_THREAD = ThreadId.make("thread-peer");
const peerMessage = PeerGate.makePeerMessageId("00000000-0000-4000-8000-000000000001");

/** One thread at `runtimeMode` with a queued peer run, a queued local run and a running one. */
const threadsWith = (
  cancels: Array<string>,
  runtimeMode: RuntimeMode = "full-access",
  onCancel: () => Effect.Effect<void> = () => Effect.void,
  events: Stream.Stream<never> = Stream.never,
  shellRuntimeMode: RuntimeMode = runtimeMode,
  shellStatus = "queued",
) => {
  const runs = [
    { id: RunId.make("run-peer"), status: "queued", queueHeld: true, userMessageId: peerMessage },
    { id: RunId.make("run-local"), status: "queued", userMessageId: MessageId.make("local") },
    {
      id: RunId.make("run-active"),
      status: "running",
      userMessageId: PeerGate.makePeerMessageId("00000000-0000-4000-8000-000000000002"),
    },
  ];
  return {
    layer: Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [{ id: PEER_THREAD, status: shellStatus, runtimeMode: shellRuntimeMode }],
          archivedThreads: [],
        } as never),
      getThreadRecords: (() =>
        Effect.succeed({ thread: { id: PEER_THREAD, runtimeMode }, runs } as never)) as never,
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "queued-run.cancel") cancels.push(command.runId);
        }).pipe(Effect.andThen(onCancel()), Effect.as({} as never)),
      streamDomainEvents: events,
    }),
  };
};

const noSessions = Layer.mock(SessionStore.SessionStore)({
  cookieName: "t3_session",
  legacyCookieName: undefined,
  listActive: () => Effect.succeed([]),
  revoke: () => Effect.succeed(false),
});

describe("PeerInbound", () => {
  it("allows peer work only at or below the ceiling", () => {
    assert.isFalse(PeerGate.peerInboundAllows("off", "approval-required"));
    assert.isTrue(PeerGate.peerInboundAllows("auto-accept-edits", "approval-required"));
    assert.isFalse(PeerGate.peerInboundAllows("auto-accept-edits", "full-access"));
    assert.isTrue(PeerGate.isPeerMessageId(peerMessage));
    assert.isFalse(PeerGate.isPeerMessageId("message:other"));
  });

  it.effect("lowering inbound below a thread's mode cancels only its queued peer runs", () =>
    Effect.gen(function* () {
      const cancels: Array<string> = [];
      const done = yield* Deferred.make<void>();
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          exowattPeerInbound: "full-access",
        }),
        streamChanges: Stream.make({
          ...DEFAULT_SERVER_SETTINGS,
          exowattPeerInbound: "auto-accept-edits" as const,
        }),
      });
      yield* Deferred.await(done).pipe(
        Effect.provide(
          PeerInbound.layer.pipe(
            Layer.provide([
              noSessions,
              settings,
              threadsWith(cancels, "full-access", () => Deferred.succeed(done, undefined)).layer,
            ]),
          ),
        ),
      );
      assert.deepStrictEqual(cancels, ["run-peer"]);
    }),
  );

  it.effect("raising a thread above the ceiling cancels the peer work queued on it", () =>
    Effect.gen(function* () {
      const cancels: Array<string> = [];
      const done = yield* Deferred.make<void>();
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          exowattPeerInbound: "auto-accept-edits",
        }),
        streamChanges: Stream.never,
      });
      const raised = Stream.make({
        type: "thread.runtime-mode-updated",
        threadId: PEER_THREAD,
        payload: { id: PEER_THREAD, runtimeMode: "full-access" },
      } as never);
      yield* Deferred.await(done).pipe(
        Effect.provide(
          PeerInbound.layer.pipe(
            Layer.provide([
              noSessions,
              settings,
              threadsWith(
                cancels,
                "full-access",
                () => Deferred.succeed(done, undefined),
                raised,
                "approval-required",
              ).layer,
            ]),
          ),
        ),
      );
      assert.deepStrictEqual(cancels, ["run-peer"]);
    }),
  );

  it.effect("starting with inbound off cancels queued peer runs left from before", () =>
    Effect.gen(function* () {
      const cancels: Array<string> = [];
      const done = yield* Deferred.make<void>();
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        streamChanges: Stream.never,
      });
      yield* Deferred.await(done).pipe(
        Effect.provide(
          PeerInbound.layer.pipe(
            Layer.provide([
              noSessions,
              settings,
              threadsWith(cancels, "approval-required", () => Deferred.succeed(done, undefined))
                .layer,
            ]),
          ),
        ),
      );
      assert.deepStrictEqual(cancels, ["run-peer"]);
    }),
  );

  it.effect("turning inbound off cancels a held peer run behind a failed run", () =>
    Effect.gen(function* () {
      const cancels: Array<string> = [];
      const done = yield* Deferred.make<void>();
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          exowattPeerInbound: "full-access",
        }),
        streamChanges: Stream.make({
          ...DEFAULT_SERVER_SETTINGS,
          exowattPeerInbound: "off" as const,
        }),
      });
      yield* Deferred.await(done).pipe(
        Effect.provide(
          PeerInbound.layer.pipe(
            Layer.provide([
              noSessions,
              settings,
              threadsWith(
                cancels,
                "approval-required",
                () => Deferred.succeed(done, undefined),
                Stream.never,
                "approval-required",
                "failed",
              ).layer,
            ]),
          ),
        ),
      );
      assert.deepStrictEqual(cancels, ["run-peer"]);
    }),
  );

  it.effect(
    "turning inbound off revokes only reverse linked-environment sessions, leaving forward ones",
    () =>
      Effect.gen(function* () {
        const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
        const done = yield* Deferred.make<void>();
        const sessions = Layer.mock(SessionStore.SessionStore)({
          cookieName: "t3_session",
          legacyCookieName: undefined,
          listActive: () => Effect.succeed(ACTIVE),
          revoke: (sessionId) =>
            Ref.updateAndGet(revoked, (ids) => [...ids, sessionId]).pipe(
              Effect.tap((ids) =>
                ids.length === 1 ? Deferred.succeed(done, undefined) : Effect.void,
              ),
              Effect.as(true),
            ),
        });
        const settings = Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            exowattPeerInbound: "full-access",
          }),
          streamChanges: Stream.make(
            { ...DEFAULT_SERVER_SETTINGS, exowattPeerInbound: "full-access" as const },
            { ...DEFAULT_SERVER_SETTINGS, exowattPeerInbound: "off" as const },
          ),
        });
        yield* Deferred.await(done).pipe(
          Effect.provide(
            PeerInbound.layer.pipe(Layer.provide([sessions, settings, threadsWith([]).layer])),
          ),
        );
        assert.deepStrictEqual(yield* Ref.get(revoked), ["peer-reverse"]);
      }),
  );
});
