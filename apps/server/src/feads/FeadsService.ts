/**
 * FeadsService - server-side home of the feads configuration: the stored token / server URL /
 * default board plus `P3_FEADS_*` overrides. Its `ExowattFeadsStatus` snapshot never carries
 * the token; polling lives in FeadsBridge and reports back through `recordPoll`.
 *
 * @module FeadsService
 */
import {
  EXOWATT_FEADS_DEFAULT_BASE_URL,
  type ExowattFeadsConfigureInput,
  ExowattFeadsError,
  type ExowattFeadsPresenceStatus,
  type ExowattFeadsStatus,
  type ExowattFeadsTestResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  subscribeBeforeSnapshot,
  type SnapshotSubscription,
} from "../utils/subscribeBeforeSnapshot.ts";
import {
  decodeFeadsIdentity,
  decodeFeadsStoredConfig,
  EMPTY_FEADS_STORED_CONFIG,
  encodeFeadsStoredConfig,
  FEADS_CONFIG_SECRET,
  FEADS_TOKEN_ENV,
  feadsIdentityProbeUrl,
  type FeadsResolvedConfig,
  type FeadsStoredConfig,
  normalizeFeadsBaseUrl,
  redactFeadsSecrets,
  resolveFeadsConfig,
} from "./FeadsConfig.ts";
import * as FeadsHttp from "./FeadsHttp.ts";

export interface FeadsPollReport {
  /** Actor the poll authenticated as; `undefined` leaves the last known actor alone. */
  readonly actor?: string | null;
  readonly error: string | null;
}

export class FeadsService extends Context.Service<
  FeadsService,
  {
    readonly status: Effect.Effect<ExowattFeadsStatus>;
    readonly subscribeStatus: Effect.Effect<
      SnapshotSubscription<ExowattFeadsStatus>,
      never,
      Scope.Scope
    >;
    /** Token included; for server-side callers (the poller) only. */
    readonly resolvedConfig: Effect.Effect<FeadsResolvedConfig>;
    /** Current config first, then one emission per `configure` / `clear`; for the poller. */
    readonly subscribeConfig: Effect.Effect<
      SnapshotSubscription<FeadsResolvedConfig>,
      never,
      Scope.Scope
    >;
    readonly configure: (
      input: ExowattFeadsConfigureInput,
    ) => Effect.Effect<ExowattFeadsStatus, ExowattFeadsError>;
    readonly clear: () => Effect.Effect<ExowattFeadsStatus, ExowattFeadsError>;
    readonly test: () => Effect.Effect<ExowattFeadsTestResult, ExowattFeadsError>;
    readonly recordPoll: (report: FeadsPollReport) => Effect.Effect<void>;
    /**
     * The presence publisher's latest state. Subscribers hear about it only when
     * something besides `lastPublishedAt` changed, so heartbeats stay off the wire.
     */
    readonly recordPresence: (presence: ExowattFeadsPresenceStatus) => Effect.Effect<void>;
  }
>()("t3/feads/FeadsService") {}

interface FeadsState {
  readonly stored: FeadsStoredConfig;
  readonly actor: string | null;
  readonly lastPollAt: string | null;
  readonly lastError: string | null;
  readonly presence: ExowattFeadsPresenceStatus | null;
}

const samePresenceExceptTime = (
  left: ExowattFeadsPresenceStatus | null,
  right: ExowattFeadsPresenceStatus,
): boolean =>
  left !== null &&
  left.enabled === right.enabled &&
  left.disabledReason === right.disabledReason &&
  left.liveRows === right.liveRows &&
  left.lastError === right.lastError;

export interface FeadsServiceOptions {
  /** Defaults to the host environment; tests pass their own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const encodeSecret = (config: FeadsStoredConfig): Uint8Array =>
  new TextEncoder().encode(encodeFeadsStoredConfig(config));

export const make = Effect.fn("FeadsService.make")(function* (options: FeadsServiceOptions = {}) {
  const env = options.env ?? (yield* HostProcess.Environment);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* FeadsHttp.FeadsHttpClient;

  const initialStored = yield* secrets.get(FEADS_CONFIG_SECRET).pipe(
    Effect.map(
      Option.match({
        onNone: () => EMPTY_FEADS_STORED_CONFIG,
        onSome: (bytes) =>
          Option.getOrElse(
            decodeFeadsStoredConfig(new TextDecoder().decode(bytes)),
            () => EMPTY_FEADS_STORED_CONFIG,
          ),
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("feads: could not read the stored configuration; starting empty.", {
        detail: error.message,
      }).pipe(Effect.as(EMPTY_FEADS_STORED_CONFIG)),
    ),
  );

  const stateRef = yield* Ref.make<FeadsState>({
    stored: initialStored,
    actor: null,
    lastPollAt: null,
    lastError: null,
    presence: null,
  });
  const statusChanges = yield* PubSub.sliding<ExowattFeadsStatus>(1);
  const configChanges = yield* PubSub.sliding<FeadsResolvedConfig>(1);
  const mutex = yield* Semaphore.make(1);

  const resolve = (state: FeadsState): FeadsResolvedConfig => resolveFeadsConfig(state.stored, env);

  const toStatus = (state: FeadsState): ExowattFeadsStatus => {
    const resolved = resolve(state);
    return {
      configured: resolved.token !== null,
      baseUrl: resolved.baseUrl,
      actor: state.actor,
      defaultBoard: resolved.defaultBoard,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      tokenSource: resolved.tokenSource,
      ...(state.presence === null ? {} : { presence: state.presence }),
    };
  };

  const status = Ref.get(stateRef).pipe(Effect.map(toStatus));
  const resolvedConfig = Ref.get(stateRef).pipe(Effect.map(resolve));

  /** Apply a state transition under the mutex and publish the resulting status. */
  const transition = (update: (state: FeadsState) => FeadsState) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const next = yield* Ref.updateAndGet(stateRef, update);
        yield* PubSub.publish(statusChanges, toStatus(next));
        return next;
      }),
    );

  const persist = (operation: string, stored: FeadsStoredConfig) =>
    secrets
      .set(FEADS_CONFIG_SECRET, encodeSecret(stored))
      .pipe(
        Effect.mapError(
          (error) =>
            new ExowattFeadsError({ operation, reason: redactFeadsSecrets(error.message) }),
        ),
      );

  const configure: FeadsService["Service"]["configure"] = Effect.fn("FeadsService.configure")(
    function* (input) {
      const current = yield* Ref.get(stateRef);
      const resolvedBefore = resolve(current);
      let stored: FeadsStoredConfig = { ...current.stored };
      let identityInvalidated = false;

      if (input.token !== undefined) {
        const token = input.token.trim();
        if (token.length === 0) {
          return yield* new ExowattFeadsError({
            operation: "configure",
            reason: "The token is empty.",
          });
        }
        if (resolvedBefore.tokenSource === "environment") {
          return yield* new ExowattFeadsError({
            operation: "configure",
            reason: `${FEADS_TOKEN_ENV} is set on the server; unset it to manage the token here.`,
          });
        }
        if (token !== current.stored.token) {
          stored = { ...stored, token };
          identityInvalidated = true;
        }
      }

      if (input.baseUrl !== undefined) {
        const baseUrl = normalizeFeadsBaseUrl(input.baseUrl);
        if (baseUrl === null) {
          return yield* new ExowattFeadsError({
            operation: "configure",
            reason: "The server must be an http(s) URL.",
          });
        }
        if (baseUrl !== resolvedBefore.baseUrl) identityInvalidated = true;
        stored = { ...stored, baseUrl };
      }

      if (input.defaultBoard !== undefined) {
        const board = input.defaultBoard?.trim() ?? "";
        const { defaultBoard: _dropped, ...rest } = stored;
        stored = board.length === 0 ? rest : { ...rest, defaultBoard: board };
      }

      yield* persist("configure", stored);
      const next = yield* transition((state) => ({
        ...state,
        stored,
        ...(identityInvalidated ? { actor: null, lastError: null } : {}),
      }));
      yield* PubSub.publish(configChanges, resolve(next));
      return toStatus(next);
    },
  );

  const clear: FeadsService["Service"]["clear"] = Effect.fn("FeadsService.clear")(function* () {
    yield* secrets.remove(FEADS_CONFIG_SECRET).pipe(
      Effect.mapError(
        (error) =>
          new ExowattFeadsError({
            operation: "clear",
            reason: redactFeadsSecrets(error.message),
          }),
      ),
    );
    // The publisher reports its own state once it notices the token is gone.
    const next = yield* transition((state) => ({
      stored: EMPTY_FEADS_STORED_CONFIG,
      actor: null,
      lastPollAt: null,
      lastError: null,
      presence: state.presence,
    }));
    yield* PubSub.publish(configChanges, resolve(next));
    return toStatus(next);
  });

  const test: FeadsService["Service"]["test"] = Effect.fn("FeadsService.test")(function* () {
    const resolved = yield* resolvedConfig;
    if (resolved.token === null) {
      return { ok: false, actor: null, error: "not_configured" } satisfies ExowattFeadsTestResult;
    }
    const outcome = yield* http
      .request({
        method: "GET",
        url: feadsIdentityProbeUrl(resolved.baseUrl),
        token: resolved.token,
      })
      .pipe(
        Effect.map((response) => decodeFeadsIdentity(response.status, response.json)),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error: redactFeadsSecrets(`${error.reason}: ${error.detail}`),
          }),
        ),
      );
    yield* transition((state) =>
      outcome.ok
        ? { ...state, actor: outcome.actor, lastError: null }
        : { ...state, lastError: outcome.error },
    );
    return outcome.ok
      ? { ok: true, actor: outcome.actor, error: null }
      : { ok: false, actor: null, error: outcome.error };
  });

  const recordPoll: FeadsService["Service"]["recordPoll"] = Effect.fn("FeadsService.recordPoll")(
    function* (report) {
      const now = yield* DateTime.now;
      yield* transition((state) => ({
        ...state,
        lastPollAt: DateTime.formatIso(now),
        lastError: report.error === null ? null : redactFeadsSecrets(report.error),
        ...(report.actor === undefined ? {} : { actor: report.actor }),
      }));
    },
  );

  const recordPresence: FeadsService["Service"]["recordPresence"] = (presence) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.getAndUpdate(stateRef, (state) => ({ ...state, presence }));
        if (samePresenceExceptTime(previous.presence, presence)) return;
        yield* PubSub.publish(statusChanges, toStatus({ ...previous, presence }));
      }),
    );

  return FeadsService.of({
    status,
    subscribeStatus: subscribeBeforeSnapshot(statusChanges, status, mutex),
    resolvedConfig,
    subscribeConfig: subscribeBeforeSnapshot(configChanges, resolvedConfig, mutex),
    configure,
    clear,
    test,
    recordPoll,
    recordPresence,
  });
});

export const layer = (options?: FeadsServiceOptions) =>
  Layer.effect(FeadsService, make(options ?? {}));

/**
 * Feads that exists but is not configured, for suites that only need the
 * service in context (the Phi driver reads `resolvedConfig` to decide what
 * presence credential to forward). Override any field for a configured feads.
 */
export const layerTest = (config?: Partial<FeadsResolvedConfig>) =>
  Layer.mock(FeadsService)({
    resolvedConfig: Effect.succeed({
      token: null,
      tokenSource: "none",
      baseUrl: EXOWATT_FEADS_DEFAULT_BASE_URL,
      defaultBoard: null,
      ...config,
    } satisfies FeadsResolvedConfig),
  });
