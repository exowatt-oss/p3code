// Exowatt distro: keep every installed coding harness pointed at this P3 server's
// `/mcp` without anyone clicking "Add to" in Customize › MCP. It writes only when the
// `p3` entry is wrong, never into a harness the user does not have, and never writes
// a dev server's random port into the machine's global harness configs.
import {
  AuthSessionId,
  AuthStandardClientScopes,
  DEFAULT_SERVER_SETTINGS,
  EXOWATT_AUTO_CONNECT_ROTATE_WITHIN_DAYS,
  EXOWATT_CONNECTOR_CATALOG,
  EXOWATT_P3_MCP_PATH,
  exowattAutoConnectTokenLabel,
  type ExowattConnectorAutoConnectAction,
  type ExowattConnectorAutoConnectHarnessResult,
  type ExowattConnectorAutoConnectReport,
  type ExowattHarnessId,
  isExowattDevServerVersion,
} from "@t3tools/contracts";
import { normalizeMcpUrl } from "@t3tools/shared/mcpUrl";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import packageJson from "../package.json" with { type: "json" };
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { base64UrlDecodeUtf8 } from "./auth/utils.ts";
import * as ServerConfig from "./config.ts";
import { EXOWATT_CONNECTOR_AGENT_TOKEN_TTL } from "./exowattConnectors.ts";
import {
  HARNESS_IDS,
  type HarnessMcpEntry,
  readHarnessMcpState,
  upsertHarnessMcpServer,
} from "./exowattHarnessConfig.ts";
import * as HarnessLaunchEnvironment from "./provider/HarnessLaunchEnvironment.ts";
import { forkParked } from "./serverActivation.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";
import * as ServerSettings from "./serverSettings.ts";

/** How often a running server re-checks the harness configs. */
export const EXOWATT_AUTO_CONNECT_INTERVAL = Duration.hours(12);

const ROTATE_WITHIN = Duration.days(EXOWATT_AUTO_CONNECT_ROTATE_WITHIN_DAYS);

/** The catalog entry for this server's own `/mcp`; `p3` is its harness name. */
const P3_CONNECTOR = EXOWATT_CONNECTOR_CATALOG.find((entry) => entry.id === "p3");
const P3_SERVER_NAME = P3_CONNECTOR?.serverName ?? "p3";

/** Only the session id matters here; verification is the auth store's job. */
const decodeSessionIdClaim = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sid: Schema.String })),
);

/**
 * The session behind a bearer token, read out of the token itself: P3's tokens
 * are `<base64url claims>.<signature>` and the claims carry `sid`. A token P3
 * cannot read is a token it cannot vouch for, so `null` means "rotate".
 */
export function sessionIdFromToken(token: string): string | null {
  const [payload] = token.trim().split(".");
  if (!payload) return null;
  try {
    return Option.getOrNull(
      Option.map(decodeSessionIdClaim(base64UrlDecodeUtf8(payload)), (claims) => claims.sid),
    );
  } catch {
    return null;
  }
}

/**
 * Why this build must not write the machine's harness configs, or `null` when
 * it may. A pushed dev server is versioned `0.0.0-dev.<sha>`, and a worktree
 * dev run fronts a Vite server (`devUrl`) on a port derived from the worktree
 * — neither is the address the machine's harnesses should dial.
 */
export function devServerSkipReason(input: {
  readonly version: string;
  readonly devUrl: string | undefined;
}): string | null {
  if (isExowattDevServerVersion(input.version)) return "This is a dev server build.";
  if (input.devUrl !== undefined) return "This server is fronting a dev web server.";
  return null;
}

/** Header names are case-insensitive, and a harness config is hand-editable. */
export function bearerTokenFromHeaders(headers: Readonly<Record<string, string>>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization") continue;
    const match = /^bearer\s+(.+)$/i.exec(value.trim());
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * The entry P3 is responsible for: the one it names `p3`, or failing that any
 * HTTP entry already dialling this server's `/mcp` under another name, so a
 * hand-written entry is rotated rather than duplicated.
 */
export function findP3Entry(
  entries: ReadonlyArray<HarnessMcpEntry>,
  url: string,
): HarnessMcpEntry | undefined {
  const target = normalizeMcpUrl(url);
  return (
    entries.find((entry) => entry.name === P3_SERVER_NAME) ??
    entries.find((entry) => entry.url !== null && normalizeMcpUrl(entry.url) === target)
  );
}

const row = (
  harness: ExowattHarnessId,
  action: ExowattConnectorAutoConnectAction,
  detail: string,
): ExowattConnectorAutoConnectHarnessResult => ({ harness, action, detail });

const skippedReport = (input: {
  readonly enabled: boolean;
  readonly detail: string;
}): ExowattConnectorAutoConnectReport => ({
  enabled: input.enabled,
  origin: null,
  harnesses: HARNESS_IDS.map((harness) => row(harness, "skipped", input.detail)),
});

export class ExowattConnectorAutoConnect extends Context.Service<
  ExowattConnectorAutoConnect,
  {
    /**
     * Bring every installed harness in line and say what happened. Never
     * fails: a harness P3 cannot read or write is one `failed` row, not a
     * broken server.
     */
    readonly reconcileNow: Effect.Effect<ExowattConnectorAutoConnectReport>;
    /**
     * Reconcile now and every twelve hours after, and again whenever the
     * setting is switched back on. Call it once the server has recorded its
     * origin in `server-runtime.json` — before that there is no url to write.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/exowattConnectorAutoConnect") {}

export const make = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  // Reading the runtime state file and the harness configs needs the server's
  // filesystem and the login-shell environment harnesses are resolved against.
  // Pinning them here keeps `reconcileNow` callable from the WebSocket RPC,
  // the MCP tool and the startup loop without each of them re-providing them.
  const harnessServices = yield* Effect.context<
    FileSystem.FileSystem | HarnessLaunchEnvironment.HarnessLaunchEnvironment
  >();

  const mint = (harness: ExowattHarnessId) => {
    const label = exowattAutoConnectTokenLabel(harness);
    return auth.issueSession({
      scopes: AuthStandardClientScopes,
      ttl: EXOWATT_CONNECTOR_AGENT_TOKEN_TTL,
      label,
      subject: label,
    });
  };

  /**
   * Mint, write, and only then drop the session the old entry was using: if
   * the write fails the harness keeps a token that still works, and the
   * session P3 just minted is revoked instead of being left orphaned in
   * Authorized Clients.
   */
  const writeEntry = Effect.fn("ExowattConnectorAutoConnect.writeEntry")(function* (input: {
    readonly harness: ExowattHarnessId;
    readonly url: string;
    readonly action: ExowattConnectorAutoConnectAction;
    readonly detail: string;
    readonly replacesSessionId: string | null;
  }) {
    const issued = yield* mint(input.harness);
    yield* upsertHarnessMcpServer({
      harness: input.harness,
      name: P3_SERVER_NAME,
      transport: "http",
      url: input.url,
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: `Bearer ${issued.token}` }],
    }).pipe(
      Effect.tapError(() =>
        auth.revokeSession(issued.sessionId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to revoke an unused auto-connect session", {
              harness: input.harness,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
    );
    if (input.replacesSessionId !== null) {
      yield* auth.revokeSession(AuthSessionId.make(input.replacesSessionId)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to revoke the replaced auto-connect session", {
            harness: input.harness,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    return row(input.harness, input.action, input.detail);
  });

  const reconcileHarness = Effect.fn("ExowattConnectorAutoConnect.reconcileHarness")(
    function* (input: {
      readonly harness: ExowattHarnessId;
      readonly url: string;
      /** `none` when P3 could not list its own sessions this run. */
      readonly sessions: Option.Option<ReadonlyMap<string, DateTime.Utc>>;
      readonly rotateBefore: DateTime.Utc;
    }) {
      const state = yield* readHarnessMcpState(input.harness);
      if (!state.installed) {
        return row(input.harness, "skipped", `${state.label} is not installed on this machine.`);
      }
      const existing = findP3Entry(state.entries, input.url);
      if (existing === undefined) {
        return yield* writeEntry({
          harness: input.harness,
          url: input.url,
          action: "added",
          detail: `Connected ${state.label} to ${input.url}.`,
          replacesSessionId: null,
        });
      }

      const token = bearerTokenFromHeaders(existing.headers);
      const sessionId = token === null ? null : sessionIdFromToken(token);
      if (normalizeMcpUrl(existing.url) !== normalizeMcpUrl(input.url)) {
        return yield* writeEntry({
          harness: input.harness,
          url: input.url,
          action: "moved",
          detail: `${state.label} pointed at ${existing.url ?? "no url"}; this server is at ${input.url}.`,
          replacesSessionId: sessionId,
        });
      }
      if (sessionId === null) {
        return yield* writeEntry({
          harness: input.harness,
          url: input.url,
          action: "rotated",
          detail: `${state.label}'s entry had no P3 token P3 could read.`,
          replacesSessionId: null,
        });
      }
      if (Option.isNone(input.sessions)) {
        // Without the session list P3 cannot tell a live token from a revoked
        // one, and guessing would mean rewriting a good config. The next run
        // decides.
        return row(
          input.harness,
          "unchanged",
          `${state.label} points here; P3 could not check the token's session this run.`,
        );
      }
      const expiresAt = input.sessions.value.get(sessionId);
      if (expiresAt === undefined) {
        return yield* writeEntry({
          harness: input.harness,
          url: input.url,
          action: "rotated",
          detail: `${state.label}'s token belonged to a session that is no longer active.`,
          replacesSessionId: null,
        });
      }
      if (DateTime.isLessThanOrEqualTo(expiresAt, input.rotateBefore)) {
        return yield* writeEntry({
          harness: input.harness,
          url: input.url,
          action: "rotated",
          detail: `${state.label}'s token expires ${DateTime.formatIso(expiresAt)}.`,
          replacesSessionId: sessionId,
        });
      }
      return row(
        input.harness,
        "unchanged",
        `${state.label} is already connected to ${input.url}.`,
      );
    },
  );

  const reconcileNow: Effect.Effect<ExowattConnectorAutoConnectReport> = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Auto-connect could not read the server settings", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    const enabled = settings?.exowattAutoConnectHarnesses ?? false;
    if (settings === null) {
      return skippedReport({ enabled, detail: "P3 could not read its own settings." });
    }
    if (!enabled) {
      return skippedReport({
        enabled,
        detail: "Auto-connect is switched off in Customize › MCP.",
      });
    }
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return skippedReport({
        enabled,
        detail: "No running server has recorded its origin yet.",
      });
    }
    const devSkip = devServerSkipReason({
      version: packageJson.version,
      devUrl: runtimeState.value.devUrl,
    });
    if (devSkip !== null) return skippedReport({ enabled, detail: devSkip });

    const origin = runtimeState.value.origin.replace(/\/+$/, "");
    const url = `${origin}${EXOWATT_P3_MCP_PATH}`;
    const sessions = yield* auth.listSessions().pipe(
      Effect.map((list) =>
        Option.some<ReadonlyMap<string, DateTime.Utc>>(
          new Map(list.map((session) => [session.sessionId, session.expiresAt] as const)),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Auto-connect could not list this server's sessions", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none<ReadonlyMap<string, DateTime.Utc>>())),
      ),
    );
    const rotateBefore = DateTime.addDuration(yield* DateTime.now, ROTATE_WITHIN);

    const harnesses = yield* Effect.forEach(HARNESS_IDS, (harness) =>
      reconcileHarness({ harness, url, sessions, rotateBefore }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Auto-connect could not reconcile a harness", {
            harness,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.as(
              row(harness, "failed", "P3 could not read or write this harness's MCP config."),
            ),
          ),
        ),
      ),
    );
    return { enabled, origin, harnesses };
  }).pipe(
    Effect.provide(harnessServices),
    Effect.withSpan("ExowattConnectorAutoConnect.reconcileNow"),
  );

  const reconcileAndLog = Effect.flatMap(reconcileNow, (report) => {
    const counts = report.harnesses.reduce<Record<string, number>>((totals, harness) => {
      totals[harness.action] = (totals[harness.action] ?? 0) + 1;
      return totals;
    }, {});
    const wrote = report.harnesses.filter(
      (harness) => harness.action !== "unchanged" && harness.action !== "skipped",
    );
    return Effect.logInfo("Exowatt auto-connect reconciled the installed harnesses", {
      origin: report.origin,
      enabled: report.enabled,
      counts,
      changed: wrote.map((harness) => `${harness.harness}: ${harness.action}`),
    });
  });

  const start = Effect.fn("ExowattConnectorAutoConnect.start")(function* () {
    const changes = yield* settingsService.subscribeChanges;
    const initial = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
    );
    let enabled = initial.exowattAutoConnectHarnesses;
    yield* forkParked(
      reconcileAndLog.pipe(
        Effect.repeat(Schedule.spaced(EXOWATT_AUTO_CONNECT_INTERVAL)),
        Effect.asVoid,
      ),
    );
    // Switching the setting on should connect the harnesses now, not in twelve
    // hours; switching it off only stops the next run.
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        const next = settings.exowattAutoConnectHarnesses;
        const turnedOn = next && !enabled;
        enabled = next;
        return turnedOn ? reconcileAndLog : Effect.void;
      }),
    );
  });

  return { reconcileNow, start } satisfies ExowattConnectorAutoConnect["Service"];
});

export const layer = Layer.effect(ExowattConnectorAutoConnect, make);
