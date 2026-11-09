// Exowatt distro: this server's inbound gate for *reverse* linked-environment sessions
// (`exowattPeerInbound`). Off refuses and revokes `p3-peer:reverse ` sessions only, never a
// forward `p3-peer:` session. Queued peer runs, held ones included, are cancelled when the gate
// drops; a peer turn already running is not stopped by turning inbound off.
import {
  CommandId,
  type ExowattPeerInbound,
  isExowattReversePeerSessionLabel,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isPeerMessageId, peerInboundAllows } from "./PeerGate.ts";

export const revokePeerSessions = Effect.fn("PeerInbound.revokePeerSessions")(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const active = yield* sessions.listActive();
  let revoked = 0;
  for (const session of active) {
    if (!isExowattReversePeerSessionLabel(session.client.label)) continue;
    if (yield* sessions.revoke(session.sessionId)) revoked += 1;
  }
  if (revoked > 0) {
    yield* Effect.logInfo("inbound off; revoked reverse linked-environment sessions", {
      revoked,
    });
  }
  return revoked;
});

/** Cancels a thread's queued, not yet started, peer runs that `inbound` no longer allows. */
const cancelThreadPeerRuns = Effect.fn("PeerInbound.cancelThreadPeerRuns")(function* (
  threadId: ThreadId,
  inbound: ExowattPeerInbound,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads.getThreadRecords(threadId, ["runs"]);
  if (peerInboundAllows(inbound, records.thread.runtimeMode)) return 0;
  let cancelled = 0;
  for (const run of records.runs) {
    if (run.status !== "queued" || !isPeerMessageId(run.userMessageId)) continue;
    yield* threads.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`server:peer-inbound-cancel:${run.id}`),
      threadId,
      runId: run.id,
    });
    cancelled += 1;
  }
  return cancelled;
});

/**
 * Running turns are left alone; only queued peer runs are cancelled. Every thread is read, since
 * a held queued run does not show in the shell status.
 */
const cancelPeerRuns = Effect.fn("PeerInbound.cancelPeerRuns")(function* (
  inbound: ExowattPeerInbound,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const snapshot = yield* threads.getShellSnapshot();
  let cancelled = 0;
  for (const shell of snapshot.threads) {
    if (peerInboundAllows(inbound, shell.runtimeMode)) continue;
    cancelled += yield* cancelThreadPeerRuns(shell.id, inbound).pipe(
      Effect.catchCause(() => Effect.succeed(0)),
    );
  }
  if (cancelled > 0) {
    yield* Effect.logInfo("peer inbound lowered; cancelled queued linked-environment runs", {
      cancelled,
      inbound,
    });
  }
  return cancelled;
});

const enforce = Effect.fn("PeerInbound.enforce")(function* (inbound: ExowattPeerInbound) {
  if (inbound === "off") yield* revokePeerSessions();
  if (inbound !== "full-access") yield* cancelPeerRuns(inbound);
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const sessions = yield* SessionStore.SessionStore;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const provide = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        SessionStore.SessionStore | ThreadManagement.ThreadManagementService
      >,
    ) =>
      effect.pipe(
        Effect.provideService(SessionStore.SessionStore, sessions),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
        Effect.ignore,
      );
    let current: ExowattPeerInbound = "off";
    // Startup: a session or queued run left from before a restart must not outlive the gate.
    const initial = yield* settings.getSettings.pipe(Effect.option);
    if (initial._tag === "Some") current = initial.value.exowattPeerInbound;
    yield* Effect.forkScoped(provide(enforce(current)));
    yield* Effect.forkScoped(
      Stream.runForEach(settings.streamChanges, (next) => {
        if (next.exowattPeerInbound === current) return Effect.void;
        current = next.exowattPeerInbound;
        return provide(enforce(current));
      }),
    );
    // A thread raised above the ceiling must not start the peer work queued on it.
    yield* Effect.forkScoped(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        event.type === "thread.runtime-mode-updated" &&
        !peerInboundAllows(current, event.payload.runtimeMode)
          ? provide(cancelThreadPeerRuns(event.threadId, current))
          : Effect.void,
      ),
    );
  }),
);
