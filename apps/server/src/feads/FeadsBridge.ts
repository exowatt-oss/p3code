/**
 * FeadsBridge - the server-side poller behind the /agents feads panels. While a token is
 * configured it reads Agentwatch, the in-progress beads and the unread inbox. A 404 door
 * degrades to `available: false`; transport errors keep the last good rows and back off.
 *
 * @module FeadsBridge
 */
import {
  type ExowattFeadsAckInput,
  type ExowattFeadsAckResult,
  type ExowattFeadsAgentwatchSnapshot,
  ExowattFeadsError,
  type ExowattFeadsInboxSnapshot,
  type ExowattFeadsIssue,
  type ExowattFeadsMyIssuesSnapshot,
  type ExowattFeadsNotification,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import {
  subscribeBeforeSnapshot,
  type SnapshotSubscription,
} from "../utils/subscribeBeforeSnapshot.ts";
import type { FeadsBeadDetail } from "./FeadsBeadBrief.ts";
import { type FeadsResolvedConfig, redactFeadsSecrets } from "./FeadsConfig.ts";
import * as FeadsHttp from "./FeadsHttp.ts";
import { nextPollDelayMs } from "./FeadsPollSchedule.ts";
import * as FeadsService from "./FeadsService.ts";
import * as FeadsMcp from "./FeadsMcp.ts";
import {
  decodeAck,
  decodeAgentwatch,
  decodeBeadComments,
  decodeBeadShow,
  decodeIssues,
  decodeNotifications,
  FEADS_ACK_PATH,
  FEADS_AGENTWATCH_PATH,
  FEADS_INBOX_PATH,
  FEADS_MY_ISSUES_PATH,
  type FeedOutcome,
} from "./FeadsWire.ts";

export class FeadsBridge extends Context.Service<
  FeadsBridge,
  {
    readonly subscribeAgentwatch: Effect.Effect<
      SnapshotSubscription<ExowattFeadsAgentwatchSnapshot>,
      never,
      Scope.Scope
    >;
    readonly subscribeMyIssues: Effect.Effect<
      SnapshotSubscription<ExowattFeadsMyIssuesSnapshot>,
      never,
      Scope.Scope
    >;
    readonly subscribeInbox: Effect.Effect<
      SnapshotSubscription<ExowattFeadsInboxSnapshot>,
      never,
      Scope.Scope
    >;
    readonly ackNotifications: (
      input: ExowattFeadsAckInput,
    ) => Effect.Effect<ExowattFeadsAckResult, ExowattFeadsError>;
    /**
     * Everything the poller and feads' MCP door know about one bead, for the
     * brief a P3 thread starts from. Never fails: a bead nobody has heard of
     * yields ids and nothing else.
     */
    readonly readBead: (issueId: string) => Effect.Effect<FeadsBeadContext>;
    /**
     * Leave a comment on a bead, over feads' MCP door. Best effort by design —
     * a bead that cannot be annotated still got its thread — so the outcome is
     * data, not a failure.
     */
    readonly commentOnBead: (input: {
      readonly issueId: string;
      readonly text: string;
    }) => Effect.Effect<FeadsCommentOutcome>;
    /** Wake the loop so the next poll happens now (no-op while unconfigured). */
    readonly pollNow: Effect.Effect<void>;
    /** Run one poll against the current configuration, synchronously. Tests. */
    readonly pollOnce: Effect.Effect<void>;
  }
>()("t3/feads/FeadsBridge") {}

/** What the server knows about one bead, plus where its dashboard lives. */
export interface FeadsBeadContext {
  readonly issueId: string;
  readonly baseUrl: string;
  readonly issue: ExowattFeadsIssue | null;
  readonly notification: ExowattFeadsNotification | null;
  readonly detail: FeadsBeadDetail | null;
}

export type FeadsCommentOutcome =
  | { readonly kind: "posted" }
  | { readonly kind: "failed"; readonly error: string };

export interface FeadsBridgeOptions {
  /** Jitter source in `[0, 1)`; defaults to `Random.next`. Tests pin it. */
  readonly random?: Effect.Effect<number>;
}

const EMPTY_AGENTWATCH: ExowattFeadsAgentwatchSnapshot = {
  available: true,
  fetchedAt: null,
  error: null,
  actor: null,
  data: null,
};
const EMPTY_MY_ISSUES: ExowattFeadsMyIssuesSnapshot = {
  available: true,
  fetchedAt: null,
  error: null,
  actor: null,
  issues: [],
};
const EMPTY_INBOX: ExowattFeadsInboxSnapshot = {
  available: true,
  fetchedAt: null,
  error: null,
  actor: null,
  notifications: [],
  unreadCount: 0,
};

interface Envelope {
  readonly available: boolean;
  readonly fetchedAt: string | null;
  readonly error: string | null;
  readonly actor: string | null;
}

/**
 * Fold one fetch outcome into a snapshot. Success replaces the rows; a missing
 * door empties them and flags `available: false`; anything else only records
 * the error so the panel keeps showing what it last knew.
 */
export function applyFeedOutcome<S extends Envelope, T>(
  previous: S,
  outcome: FeedOutcome<T>,
  now: string,
  onData: (data: T) => Omit<S, keyof Envelope>,
  empty: Omit<S, keyof Envelope>,
): S {
  switch (outcome.kind) {
    case "ok":
      return {
        ...previous,
        ...onData(outcome.data),
        available: true,
        fetchedAt: now,
        error: null,
        actor: outcome.actor ?? previous.actor,
      };
    case "missing":
      return { ...previous, ...empty, available: false, fetchedAt: now, error: null };
    case "unauthorized":
    case "error":
      return { ...previous, error: outcome.error };
  }
}

export const isFeedFailure = (
  outcome: FeedOutcome<unknown>,
): outcome is Extract<FeedOutcome<unknown>, { readonly kind: "unauthorized" | "error" }> =>
  outcome.kind === "unauthorized" || outcome.kind === "error";

export const make = Effect.fn("FeadsBridge.make")(function* (options: FeadsBridgeOptions = {}) {
  const random = options.random ?? Random.next;
  const feads = yield* FeadsService.FeadsService;
  const http = yield* FeadsHttp.FeadsHttpClient;

  const agentwatchRef = yield* Ref.make(EMPTY_AGENTWATCH);
  const myIssuesRef = yield* Ref.make(EMPTY_MY_ISSUES);
  const inboxRef = yield* Ref.make(EMPTY_INBOX);
  const agentwatchChanges = yield* PubSub.sliding<ExowattFeadsAgentwatchSnapshot>(1);
  const myIssuesChanges = yield* PubSub.sliding<ExowattFeadsMyIssuesSnapshot>(1);
  const inboxChanges = yield* PubSub.sliding<ExowattFeadsInboxSnapshot>(1);
  const mutex = yield* Semaphore.make(1);
  const failuresRef = yield* Ref.make(0);
  const lastLoggedErrorRef = yield* Ref.make<string | null>(null);
  const wake = yield* Queue.unbounded<void>();

  const publishAll = mutex.withPermits(1)(
    Effect.gen(function* () {
      yield* PubSub.publish(agentwatchChanges, yield* Ref.get(agentwatchRef));
      yield* PubSub.publish(myIssuesChanges, yield* Ref.get(myIssuesRef));
      yield* PubSub.publish(inboxChanges, yield* Ref.get(inboxRef));
    }),
  );

  const resetSnapshots = Effect.gen(function* () {
    yield* Ref.set(agentwatchRef, EMPTY_AGENTWATCH);
    yield* Ref.set(myIssuesRef, EMPTY_MY_ISSUES);
    yield* Ref.set(inboxRef, EMPTY_INBOX);
    yield* Ref.set(failuresRef, 0);
    yield* Ref.set(lastLoggedErrorRef, null);
    yield* publishAll;
  });

  const fetchFeed = <T>(
    config: FeadsResolvedConfig & { readonly token: string },
    path: string,
    decode: (status: number, json: unknown) => FeedOutcome<T>,
  ): Effect.Effect<FeedOutcome<T>> =>
    http.request({ method: "GET", url: `${config.baseUrl}${path}`, token: config.token }).pipe(
      Effect.map((response) => decode(response.status, response.json)),
      Effect.catch((error) =>
        Effect.succeed<FeedOutcome<T>>({
          kind: "error",
          error: redactFeadsSecrets(`${error.reason}: ${error.detail}`),
        }),
      ),
    );

  /** Log only on transitions: the first failure and the recovery, never per poll. */
  const noteOutcome = Effect.fn("FeadsBridge.noteOutcome")(function* (error: string | null) {
    const previous = yield* Ref.get(lastLoggedErrorRef);
    if (error === previous) return;
    yield* Ref.set(lastLoggedErrorRef, error);
    if (error === null) {
      yield* Effect.logInfo("feads: polling recovered.");
    } else {
      yield* Effect.logWarning("feads: poll failed; backing off.", { detail: error });
    }
  });

  const pollWith = Effect.fn("FeadsBridge.pollWith")(function* (config: FeadsResolvedConfig) {
    if (config.token === null) return;
    const authed = { ...config, token: config.token };
    const [agentwatch, issues, inbox] = yield* Effect.all(
      [
        fetchFeed(authed, FEADS_AGENTWATCH_PATH, decodeAgentwatch),
        fetchFeed(authed, FEADS_MY_ISSUES_PATH, decodeIssues),
        fetchFeed(authed, FEADS_INBOX_PATH, decodeNotifications),
      ],
      { concurrency: "unbounded" },
    );
    const now = DateTime.formatIso(yield* DateTime.now);

    yield* Ref.update(agentwatchRef, (previous) =>
      applyFeedOutcome(previous, agentwatch, now, (data) => ({ data }), { data: null }),
    );
    yield* Ref.update(myIssuesRef, (previous) =>
      applyFeedOutcome(previous, issues, now, (data) => ({ issues: data }), { issues: [] }),
    );
    yield* Ref.update(inboxRef, (previous) =>
      applyFeedOutcome(
        previous,
        inbox,
        now,
        (data) => ({ notifications: data.notifications, unreadCount: data.unreadCount }),
        { notifications: [], unreadCount: 0 },
      ),
    );
    yield* publishAll;

    const outcomes: ReadonlyArray<FeedOutcome<unknown>> = [agentwatch, issues, inbox];
    let actor: string | null = null;
    let error: string | null = null;
    for (const outcome of outcomes) {
      if (outcome.kind === "ok" && actor === null) actor = outcome.actor;
      if (isFeedFailure(outcome) && error === null) error = outcome.error;
    }
    yield* error === null ? Ref.set(failuresRef, 0) : Ref.update(failuresRef, (n) => n + 1);
    yield* feads.recordPoll({ ...(actor === null ? {} : { actor }), error });
    yield* noteOutcome(error);
  });

  const pollOnce = feads.resolvedConfig.pipe(Effect.flatMap(pollWith));

  const pollNow = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  const ackNotifications: FeadsBridge["Service"]["ackNotifications"] = Effect.fn(
    "FeadsBridge.ackNotifications",
  )(function* (input) {
    const config = yield* feads.resolvedConfig;
    if (config.token === null) {
      return yield* new ExowattFeadsError({ operation: "ack", reason: "not_configured" });
    }
    const ids = input.ids ?? [];
    const all = input.all === true;
    if (!all && ids.length === 0) {
      return yield* new ExowattFeadsError({ operation: "ack", reason: "nothing_to_ack" });
    }
    const body = all ? { all: true } : { ids };
    const outcome = yield* http
      .request({
        method: "POST",
        url: `${config.baseUrl}${FEADS_ACK_PATH}`,
        token: config.token,
        body,
      })
      .pipe(
        Effect.map((response) => decodeAck(response.status, response.json)),
        Effect.mapError(
          (error) =>
            new ExowattFeadsError({
              operation: "ack",
              reason: redactFeadsSecrets(`${error.reason}: ${error.detail}`),
            }),
        ),
      );
    switch (outcome.kind) {
      case "missing":
        return yield* new ExowattFeadsError({ operation: "ack", reason: "http_404" });
      case "unauthorized":
      case "error":
        return yield* new ExowattFeadsError({ operation: "ack", reason: outcome.error });
      case "ok":
        break;
    }
    // Optimistic: drop the rows now, then let the next poll confirm.
    yield* Ref.update(inboxRef, (previous) => {
      const remaining = all
        ? []
        : previous.notifications.filter((notification) => !ids.includes(notification.id));
      const removed = previous.notifications.length - remaining.length;
      return {
        ...previous,
        notifications: remaining,
        unreadCount: Math.max(0, previous.unreadCount - removed),
      };
    });
    yield* publishAll;
    yield* pollNow;
    return outcome.data;
  });

  /** The MCP door, with this bridge's HTTP client already supplied. */
  const callMcp = (
    target: FeadsMcp.FeadsMcpTarget,
    calls: ReadonlyArray<FeadsMcp.FeadsMcpCall>,
  ): Effect.Effect<ReadonlyArray<FeadsMcp.FeadsMcpOutcome>> =>
    FeadsMcp.callFeadsMcpTools(target, calls).pipe(
      Effect.provideService(FeadsHttp.FeadsHttpClient, http),
    );

  /**
   * The bead as feads itself describes it: the `show` and `comments` tools on
   * its MCP door, in one session. Forgiven anything — an unreachable door must
   * not stop a thread from opening with the listing-only brief.
   */
  const readBeadOverMcp = Effect.fn("FeadsBridge.readBeadOverMcp")(function* (
    issueId: string,
    token: string,
    baseUrl: string,
  ): Effect.fn.Return<{
    readonly issue: ExowattFeadsIssue | null;
    readonly detail: FeadsBeadDetail | null;
  }> {
    const [shown, listed] = yield* callMcp({ baseUrl, token }, [
      { name: "show", arguments: { issue_id: issueId } },
      { name: "comments", arguments: { issue_id: issueId } },
    ]);
    const bead = shown?.kind === "ok" ? decodeBeadShow(shown.json) : null;
    const comments = listed?.kind === "ok" ? decodeBeadComments(listed.json) : [];
    if (bead === null) {
      return { issue: null, detail: comments.length === 0 ? null : { comments } };
    }
    return { issue: bead.issue, detail: { ...bead.detail, comments } };
  });

  const readBead: FeadsBridge["Service"]["readBead"] = Effect.fn("FeadsBridge.readBead")(
    function* (issueId) {
      const config = yield* feads.resolvedConfig;
      const issues = yield* Ref.get(myIssuesRef);
      const inbox = yield* Ref.get(inboxRef);
      const listed = issues.issues.find((row) => row.id === issueId) ?? null;
      // The newest row mentioning the bead: its snippet is why it turned up.
      const notification =
        inbox.notifications.find((row) => row.issueId === issueId) ??
        inbox.notifications.find((row) => row.relatedIssue === issueId) ??
        null;
      const fromFeads =
        config.token === null
          ? { issue: null, detail: null }
          : yield* readBeadOverMcp(issueId, config.token, config.baseUrl);
      return {
        issueId,
        baseUrl: config.baseUrl,
        // feads' own row is richer than the listing (and the listing route may
        // not exist at all), so it wins when both are there.
        issue: fromFeads.issue ?? listed,
        notification,
        detail: fromFeads.detail,
      };
    },
  );

  const commentOnBead: FeadsBridge["Service"]["commentOnBead"] = Effect.fn(
    "FeadsBridge.commentOnBead",
  )(function* ({ issueId, text }) {
    const config = yield* feads.resolvedConfig;
    if (config.token === null) return { kind: "failed", error: "not_configured" } as const;
    const [outcome] = yield* callMcp({ baseUrl: config.baseUrl, token: config.token }, [
      { name: "comment", arguments: { issue_id: issueId, text } },
    ]);
    return outcome?.kind === "ok"
      ? ({ kind: "posted" } as const)
      : ({ kind: "failed", error: outcome?.error ?? "no_response" } as const);
  });

  // Configuration changes reset everything and wake the loop; the loop itself
  // idles on the wake queue while no token is configured.
  const { latest: initialConfig, changes: configChanges } = yield* feads.subscribeConfig;
  const configRef = yield* Ref.make(initialConfig);
  yield* Stream.runForEach(configChanges, (config) =>
    Effect.gen(function* () {
      yield* Ref.set(configRef, config);
      yield* resetSnapshots;
      yield* pollNow;
    }),
  ).pipe(Effect.forkScoped);

  const iteration = Effect.gen(function* () {
    const config = yield* Ref.get(configRef);
    if (config.token === null) {
      yield* Queue.take(wake);
      return;
    }
    yield* pollWith(config);
    const failures = yield* Ref.get(failuresRef);
    const delay = nextPollDelayMs(failures, yield* random);
    yield* Effect.sleep(delay).pipe(Effect.race(Queue.take(wake)));
  });

  yield* forkParked(Effect.forever(iteration));

  return FeadsBridge.of({
    subscribeAgentwatch: subscribeBeforeSnapshot(agentwatchChanges, Ref.get(agentwatchRef), mutex),
    subscribeMyIssues: subscribeBeforeSnapshot(myIssuesChanges, Ref.get(myIssuesRef), mutex),
    subscribeInbox: subscribeBeforeSnapshot(inboxChanges, Ref.get(inboxRef), mutex),
    ackNotifications,
    readBead,
    commentOnBead,
    pollNow,
    pollOnce,
  });
});

export const layer = (options?: FeadsBridgeOptions) =>
  Layer.effect(FeadsBridge, make(options ?? {}));
