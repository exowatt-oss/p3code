/**
 * FeadsPresencePublisher - feads Agentwatch presence for P3 threads on every engine except
 * Phi, which publishes its own rows (double counting must never happen). Each live session's
 * `main` row is re-sent every 30 s (feads counts a row live for 45 s) and the module fails open.
 *
 * @module FeadsPresencePublisher
 */
import {
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  PROVIDER_DISPLAY_NAMES,
  type ProviderSessionId,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as FeadsHttp from "./FeadsHttp.ts";
import * as FeadsService from "./FeadsService.ts";
import { FEADS_PRESENCE_PATH } from "./FeadsWire.ts";

const FEADS_PRESENCE_ENV = "P3_FEADS_PRESENCE";
export const FEADS_PRESENCE_HEARTBEAT_MS = 30_000;
/** Coalesces a burst of thread changes into one PUT. */
export const FEADS_PRESENCE_DEBOUNCE_MS = 1_000;
const FEADS_PRESENCE_MAX_ROWS = 64;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const RETRY_JITTER_MAX_MS = 1_000;
const RETRY_AFTER_MAX_MS = 10 * 60_000;
/** feads prunes a row this long after its last heartbeat; deleting it later is moot. */
const ROW_EXPIRY_MS = 90_000;
const SHUTDOWN_BUDGET = Duration.seconds(5);
const TAIL_RESUBSCRIBE_DELAY = Duration.seconds(5);
const PHI_DRIVER = "phi";
const P3_CLIENT = "p3";
const MAX_ID_BYTES = 128;
const MAX_LABEL_BYTES = 80;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;
// feads 400s a row whose text holds a control character.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
const ACTIVE_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "pending",
  "running",
  "waiting",
]);

/** One feads runtime-presence row. The key set is feads' contract: it 400s on any other key. */
export interface FeadsPresenceRow {
  readonly session_id: string;
  readonly runtime_id: string;
  readonly run_id: string;
  readonly parent_run_id: string;
  readonly kind: "main";
  readonly handle: string;
  readonly display_name: string;
  readonly status: "working" | "idle";
  readonly model: string;
  readonly activity: string;
  readonly context_percent: number;
  readonly started_at: number;
  readonly client: string;
}

export interface FeadsPresencePublisherOptions {
  /** Defaults to the host environment; tests pass their own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Jitter source in `[0, 1)`; defaults to `Random.next`. Tests pin it. */
  readonly random?: Effect.Effect<number>;
}

function presenceKilled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[FEADS_PRESENCE_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).length;

function boundedText(value: string | null | undefined, maxBytes: number): string {
  const text = (value ?? "").replace(CONTROL_CHARACTERS, " ").trim();
  if (byteLength(text) <= maxBytes) return text;
  const chars = Array.from(text);
  while (chars.length > 0 && byteLength(chars.join("")) > maxBytes) chars.pop();
  return chars.join("").trimEnd();
}

const sessionKey = (threadId: ThreadId, providerSessionId: ProviderSessionId) =>
  `${threadId}\u0000${providerSessionId}`;

/** A short, fixed word or a tool name; never arguments, output, paths or prompt text. */
function itemActivity(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "search";
    case "web_search":
      return "web_search";
    case "dynamic_tool":
      return item.toolName !== null && SAFE_TOOL_NAME.test(item.toolName) ? item.toolName : "tool";
    case "approval_request":
      return "approval";
    case "user_input_request":
      return "question";
    default:
      return null;
  }
}

function sameRow(left: FeadsPresenceRow | undefined, right: FeadsPresenceRow): boolean {
  if (left === undefined) return false;
  return (Object.keys(right) as Array<keyof FeadsPresenceRow>).every(
    (key) => left[key] === right[key],
  );
}

/** Seconds or an HTTP date, capped; `null` when absent or unreadable. */
function retryAfterMs(header: string | undefined, now: number): number | null {
  const value = header?.trim();
  if (!value) return null;
  const parsed = /^\d+(?:\.\d+)?$/u.test(value)
    ? Number(value) * 1000
    : /^[A-Za-z]{3},/u.test(value)
      ? Date.parse(value) - now
      : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, parsed)) : null;
}

interface TrackedSession {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly startedAt: number;
  /**
   * The row's display name. Not the thread title: a thread whose title
   * generation failed keeps its first prompt as its title, and prompt text
   * never leaves the server. An empty name would make feads label it "phi".
   */
  readonly engine: string;
  model: string | null;
  starting: boolean;
}

interface TrackedThread {
  /** The latest run's model or the thread's new selection; else the session's. */
  model: string | null;
  tool: { readonly itemId: TurnItemId; readonly name: string } | null;
  contextPercent: number;
}

interface Credential {
  readonly token: string;
  readonly baseUrl: string;
}

type Attempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly category: string; readonly retryAfterMs: number | null };

const run = Effect.fn("FeadsPresencePublisher.run")(function* (
  options: FeadsPresencePublisherOptions,
) {
  const env = options.env ?? (yield* HostProcess.Environment);
  const random = options.random ?? Random.next;
  const feads = yield* FeadsService.FeadsService;

  if (presenceKilled(env)) {
    yield* feads.recordPresence({
      enabled: false,
      disabledReason: "kill_switch",
      liveRows: 0,
      lastPublishedAt: null,
      lastError: null,
    });
    return;
  }

  const http = yield* FeadsHttp.FeadsHttpClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const crypto = yield* Digest.Digest;
  const environmentId: EnvironmentId = yield* (yield* ServerEnvironment.ServerEnvironment)
    .getEnvironmentId;

  const digest = (text: string) =>
    crypto
      .digest(Digest.sha256, utf8.encode(text))
      .pipe(Effect.map((bytes) => Hex.encode(bytes).slice(0, 40)));

  /**
   * The runtime id is stable per provider session, so a heartbeat refreshes the
   * same row, and distinct per environment, thread and session, so a resumed
   * thread or a second P3 server on the same token never reuses one (feads 409s
   * a runtime id that changes its session). The session id is the thread id.
   */
  const identify = Effect.fn("FeadsPresencePublisher.identify")(function* (
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
  ) {
    const runtimeId = `p3-${yield* digest(`${environmentId}\u0000${sessionKey(threadId, providerSessionId)}`)}`;
    const usable = byteLength(threadId) <= MAX_ID_BYTES && !CONTROL_CHARACTER.test(threadId);
    const sessionId = usable ? threadId : `p3-thread-${yield* digest(threadId)}`;
    return { runtimeId, sessionId };
  });

  // Tracked from the event tail, sessions by `sessionKey`. Plain maps: one
  // fiber writes, the loop reads.
  const sessions = new Map<string, TrackedSession>();
  const threads = new Map<ThreadId, TrackedThread>();
  const activeRuns = new Map<ThreadId, Set<RunId>>();

  // What feads holds, by runtime id, and the credential it was sent with.
  const published = new Map<string, { readonly row: FeadsPresenceRow; readonly sentAt: number }>();
  let publishedWith: Credential | null = null;
  let dirtyAt: number | null = null;
  let heartbeatAt: number | null = null;
  let retryAt: number | null = null;
  let failureStreak = 0;
  let lastError: string | null = null;
  let lastPublishedAt: string | null = null;
  const loggedCategories = new Set<string>();
  const wake = yield* Queue.sliding<void>(1);

  const markDirty = Effect.gen(function* () {
    if (dirtyAt === null) dirtyAt = yield* Clock.currentTimeMillis;
    yield* Queue.offer(wake, undefined);
  });

  const dropSession = Effect.fn("FeadsPresencePublisher.dropSession")(function* (key: string) {
    const session = sessions.get(key);
    if (session === undefined) return;
    sessions.delete(key);
    if (![...sessions.values()].some((other) => other.threadId === session.threadId)) {
      threads.delete(session.threadId);
    }
    yield* markDirty;
  });

  const dropThread = (threadId: ThreadId) =>
    Effect.forEach(
      [...sessions.entries()].filter(([, session]) => session.threadId === threadId),
      ([key]) => dropSession(key),
      { discard: true },
    );

  const onSession = Effect.fn("FeadsPresencePublisher.onSession")(function* (
    threadId: ThreadId,
    session: OrchestrationV2ProviderSession,
  ) {
    if (session.driver === PHI_DRIVER) return;
    const key = sessionKey(threadId, session.id);
    if (session.status === "stopped" || session.status === "error") {
      return yield* dropSession(key);
    }
    const existing = sessions.get(key);
    if (existing === undefined) {
      // A failed digest only costs this session its row; it never reaches the turn.
      const ids = yield* identify(threadId, session.id).pipe(Effect.option);
      if (Option.isNone(ids)) return;
      if (!threads.has(threadId)) {
        threads.set(threadId, { model: null, tool: null, contextPercent: 0 });
      }
      sessions.set(key, {
        threadId,
        ...ids.value,
        startedAt: DateTime.toEpochMillis(session.createdAt),
        engine: boundedText(
          PROVIDER_DISPLAY_NAMES[session.driver] ?? session.driver,
          MAX_LABEL_BYTES,
        ),
        model: session.model,
        starting: session.status === "starting",
      });
    } else {
      existing.model = session.model;
      existing.starting = session.status === "starting";
    }
    yield* markDirty;
  });

  const onRun = Effect.fn("FeadsPresencePublisher.onRun")(function* (run: OrchestrationV2Run) {
    const active = ACTIVE_RUN_STATUSES.has(run.status);
    const runs = activeRuns.get(run.threadId);
    if (active) {
      if (runs === undefined) activeRuns.set(run.threadId, new Set([run.id]));
      else runs.add(run.id);
    } else if (runs !== undefined) {
      runs.delete(run.id);
      if (runs.size === 0) activeRuns.delete(run.threadId);
    }
    const thread = threads.get(run.threadId);
    if (thread === undefined) return;
    thread.model = run.modelSelection.model;
    if (!activeRuns.has(run.threadId)) thread.tool = null;
    yield* markDirty;
  });

  const onTurnItem = Effect.fn("FeadsPresencePublisher.onTurnItem")(function* (
    item: OrchestrationV2TurnItem,
  ) {
    const thread = threads.get(item.threadId);
    const name = thread === undefined ? null : itemActivity(item);
    if (thread === undefined || name === null) return;
    if (ACTIVE_ITEM_STATUSES.has(item.status)) {
      if (thread.tool?.itemId === item.id && thread.tool.name === name) return;
      thread.tool = { itemId: item.id, name };
    } else if (thread.tool?.itemId === item.id) {
      thread.tool = null;
    } else {
      return;
    }
    yield* markDirty;
  });

  const onProviderTurn = Effect.fn("FeadsPresencePublisher.onProviderTurn")(function* (
    threadId: ThreadId,
    turn: OrchestrationV2ProviderTurn,
  ) {
    const thread = threads.get(threadId);
    const usage = turn.tokenUsage;
    const maxTokens = usage?.maxTokens ?? 0;
    if (thread === undefined || usage === undefined || maxTokens <= 0) return;
    const percent = Math.round(Math.min(100, Math.max(0, (usage.usedTokens / maxTokens) * 100)));
    if (percent === thread.contextPercent) return;
    thread.contextPercent = percent;
    yield* markDirty;
  });

  const onModelSelection = Effect.fn("FeadsPresencePublisher.onModelSelection")(function* (
    payload: OrchestrationV2AppThread,
  ) {
    const thread = threads.get(payload.id);
    if (thread === undefined || thread.model === payload.modelSelection.model) return;
    thread.model = payload.modelSelection.model;
    yield* markDirty;
  });

  const onEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "provider-session.attached":
      case "provider-session.updated":
        return onSession(event.threadId, event.payload);
      case "provider-session.detached":
        return dropSession(sessionKey(event.threadId, event.payload.providerSessionId));
      case "run.created":
      case "run.updated":
        return onRun(event.payload);
      case "turn-item.updated":
        return onTurnItem(event.payload);
      case "provider-turn.updated":
        return onProviderTurn(event.threadId, event.payload);
      case "thread.model-selection-updated":
        return onModelSelection(event.payload);
      case "thread.deleted":
        activeRuns.delete(event.payload.id);
        return dropThread(event.payload.id);
      default:
        return Effect.void;
    }
  };

  const desiredRows = (): ReadonlyArray<FeadsPresenceRow> =>
    [...sessions.values()].map((session) => {
      const thread = threads.get(session.threadId);
      const working = activeRuns.has(session.threadId);
      return {
        session_id: session.sessionId,
        runtime_id: session.runtimeId,
        run_id: session.runtimeId,
        parent_run_id: "",
        kind: "main",
        handle: "main",
        display_name: session.engine,
        status: working ? "working" : "idle",
        model: boundedText(thread?.model ?? session.model, MAX_ID_BYTES),
        activity: working ? (thread?.tool?.name ?? "thinking") : session.starting ? "starting" : "",
        context_percent: thread?.contextPercent ?? 0,
        started_at: session.startedAt,
        client: P3_CLIENT,
      };
    });

  const send = (
    credential: Credential,
    method: "PUT" | "DELETE",
    body: unknown,
    now: number,
  ): Effect.Effect<Attempt> =>
    http
      .request({
        method,
        url: `${credential.baseUrl}${FEADS_PRESENCE_PATH}`,
        token: credential.token,
        body,
      })
      .pipe(
        Effect.map((response): Attempt =>
          response.status >= 200 && response.status < 300
            ? { ok: true }
            : {
                ok: false,
                category: `http_${response.status}`,
                retryAfterMs: retryAfterMs(response.headers["retry-after"], now),
              },
        ),
        Effect.catchTags({
          FeadsHttpError: (error) =>
            Effect.succeed<Attempt>({ ok: false, category: error.reason, retryAfterMs: null }),
        }),
      );

  /** Best effort, one attempt each: a row that survives fades out of feads within 90 s. */
  const retractAll = Effect.fn("FeadsPresencePublisher.retractAll")(function* (
    credential: Credential,
    now: number,
  ) {
    const runtimeIds = [...published.keys()];
    published.clear();
    publishedWith = null;
    heartbeatAt = null;
    yield* Effect.forEach(
      runtimeIds,
      (runtimeId) => send(credential, "DELETE", { runtime_id: runtimeId }, now),
      { concurrency: 4, discard: true },
    );
  });

  const report = (configured: boolean) =>
    feads.recordPresence({
      enabled: configured,
      disabledReason: configured ? null : "not_configured",
      liveRows: published.size,
      lastPublishedAt,
      lastError,
    });

  const cycle = Effect.gen(function* () {
    const config = yield* feads.resolvedConfig;
    const now = yield* Clock.currentTimeMillis;
    dirtyAt = null;
    if (
      publishedWith !== null &&
      (config.token !== publishedWith.token || config.baseUrl !== publishedWith.baseUrl)
    ) {
      yield* retractAll(publishedWith, now);
    }
    if (config.token === null) {
      retryAt = null;
      failureStreak = 0;
      lastError = null;
      return yield* report(false);
    }
    const credential: Credential = { token: config.token, baseUrl: config.baseUrl };

    const desired = desiredRows();
    const desiredIds = new Set(desired.map((row) => row.runtime_id));
    const heartbeat = heartbeatAt !== null && now >= heartbeatAt;
    const changed = desired.filter(
      (row) => heartbeat || !sameRow(published.get(row.runtime_id)?.row, row),
    );
    const ended = [...published.entries()].filter(([runtimeId]) => !desiredIds.has(runtimeId));

    let failure: Extract<Attempt, { readonly ok: false }> | null = null;
    let accepted = false;
    for (let offset = 0; offset < changed.length; offset += FEADS_PRESENCE_MAX_ROWS) {
      const rows = changed.slice(offset, offset + FEADS_PRESENCE_MAX_ROWS);
      const attempt = yield* send(credential, "PUT", { version: 1, rows }, now);
      if (!attempt.ok) {
        failure = attempt;
        break;
      }
      accepted = true;
      publishedWith = credential;
      for (const row of rows) published.set(row.runtime_id, { row, sentAt: now });
    }
    for (const [runtimeId, entry] of failure === null ? ended : []) {
      if (now - entry.sentAt >= ROW_EXPIRY_MS) {
        published.delete(runtimeId);
        continue;
      }
      const attempt = yield* send(credential, "DELETE", { runtime_id: runtimeId }, now);
      if (!attempt.ok) {
        failure = attempt;
        break;
      }
      accepted = true;
      published.delete(runtimeId);
    }

    if (failure === null) {
      if (lastError !== null) yield* Effect.logInfo("feads presence: publishing recovered.");
      failureStreak = 0;
      retryAt = null;
      lastError = null;
      loggedCategories.clear();
      if (accepted) lastPublishedAt = DateTime.formatIso(yield* DateTime.now);
      heartbeatAt =
        published.size === 0
          ? null
          : heartbeat || heartbeatAt === null
            ? now + FEADS_PRESENCE_HEARTBEAT_MS
            : heartbeatAt;
    } else {
      failureStreak = Math.min(failureStreak + 1, 31);
      const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failureStreak - 1));
      const jitter = Math.floor((yield* random) * Math.min(RETRY_JITTER_MAX_MS, exponential));
      const delay = Math.max(
        RETRY_BASE_MS,
        failure.retryAfterMs ?? Math.min(RETRY_MAX_MS, exponential + jitter),
      );
      retryAt = now + delay;
      lastError = failure.category;
      if (!loggedCategories.has(failure.category)) {
        loggedCategories.add(failure.category);
        yield* Effect.logWarning("feads presence: publish failed; backing off.", {
          category: failure.category,
          retryInMs: delay,
        });
      }
    }
    yield* report(true);
  });

  /** When the loop next has work: a retry, a debounced change, or a heartbeat. */
  const nextDueAt = (): number | null =>
    retryAt ?? (dirtyAt === null ? heartbeatAt : dirtyAt + FEADS_PRESENCE_DEBOUNCE_MS);

  const iteration = Effect.gen(function* () {
    const dueAt = nextDueAt();
    if (dueAt === null) {
      yield* Queue.take(wake);
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    if (dueAt > now) {
      yield* Effect.sleep(Duration.millis(dueAt - now)).pipe(Effect.race(Queue.take(wake)));
      return;
    }
    yield* cycle;
  });

  // Losing the tail means losing session ends: forget everything (the loop then
  // deletes it) and resubscribe; live sessions return on their next update.
  const followTail = Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("feads presence: lost the event tail; resubscribing.", { cause }),
    ),
    Effect.andThen(
      Effect.gen(function* () {
        sessions.clear();
        threads.clear();
        activeRuns.clear();
        yield* markDirty;
      }),
    ),
    Effect.andThen(Effect.sleep(TAIL_RESUBSCRIBE_DELAY)),
    Effect.forever,
  );
  yield* Effect.forkScoped(followTail);

  // A new or removed token is picked up straight away, without waiting out a backoff.
  const { latest: initialConfig, changes: configChanges } = yield* feads.subscribeConfig;
  yield* Stream.runForEach(configChanges, () =>
    Effect.sync(() => {
      retryAt = null;
      failureStreak = 0;
    }).pipe(Effect.andThen(markDirty)),
  ).pipe(Effect.forkScoped);

  yield* report(initialConfig.token !== null);

  // Registered before the loop forks, so it runs after the loop is interrupted.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (publishedWith === null) return;
      yield* retractAll(publishedWith, yield* Clock.currentTimeMillis);
    }).pipe(Effect.timeoutOption(SHUTDOWN_BUDGET), Effect.asVoid),
  );
  yield* forkParked(Effect.forever(iteration));
});

export const layer = (options?: FeadsPresencePublisherOptions) =>
  Layer.effectDiscard(run(options ?? {}));
