/**
 * Pure pieces of the feads integration: how the stored config and the environment combine
 * into the configuration in force, URL normalisation, and the decoder for the identity probe.
 * No I/O, so these are the unit-tested surface; `FeadsService` is the effectful shell.
 *
 * @module FeadsConfig
 */
import { EXOWATT_FEADS_DEFAULT_BASE_URL, type ExowattFeadsTokenSource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Secret-store entry holding everything Settings saved. Token included, so it never leaves the server. */
export const FEADS_CONFIG_SECRET = "exowatt-feads-config";

export const FEADS_TOKEN_ENV = "P3_FEADS_TOKEN";
export const FEADS_URL_ENV = "P3_FEADS_URL";
export const FEADS_BOARD_ENV = "P3_FEADS_BOARD";

export const FeadsStoredConfig = Schema.Struct({
  token: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  defaultBoard: Schema.optionalKey(Schema.String),
});
export type FeadsStoredConfig = typeof FeadsStoredConfig.Type;

export const EMPTY_FEADS_STORED_CONFIG: FeadsStoredConfig = {};

export const decodeFeadsStoredConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(FeadsStoredConfig),
);
export const encodeFeadsStoredConfig = Schema.encodeSync(Schema.fromJsonString(FeadsStoredConfig));

export interface FeadsResolvedConfig {
  readonly token: string | null;
  readonly tokenSource: ExowattFeadsTokenSource;
  readonly baseUrl: string;
  readonly defaultBoard: string | null;
}

const nonEmpty = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * Accepts what a person types into the Server field and returns the origin
 * feads is reached at, or `null` if it is not an http(s) URL. Trailing slashes
 * and paths are dropped: the integration owns the `/api/...` suffixes.
 */
export function normalizeFeadsBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.length === 0) return null;
  return url.origin;
}

/**
 * Environment wins for the token (headless servers are configured that way and
 * must not be silently overridden from a browser tab); for the URL and board the
 * environment is a default that Settings may still override.
 */
export function resolveFeadsConfig(
  stored: FeadsStoredConfig,
  env: Readonly<Record<string, string | undefined>>,
): FeadsResolvedConfig {
  const envToken = nonEmpty(env[FEADS_TOKEN_ENV]);
  const storedToken = nonEmpty(stored.token);
  const token = envToken ?? storedToken;
  const tokenSource: ExowattFeadsTokenSource = envToken
    ? "environment"
    : storedToken
      ? "settings"
      : "none";
  const baseUrl =
    normalizeFeadsBaseUrl(stored.baseUrl ?? "") ??
    normalizeFeadsBaseUrl(env[FEADS_URL_ENV] ?? "") ??
    EXOWATT_FEADS_DEFAULT_BASE_URL;
  const defaultBoard = nonEmpty(stored.defaultBoard) ?? nonEmpty(env[FEADS_BOARD_ENV]);
  return { token, tokenSource, baseUrl, defaultBoard };
}

export function feadsIdentityProbeUrl(baseUrl: string): string {
  return `${baseUrl}/api/notifications?unread_only=1&limit=1`;
}

const IdentityBody = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  actor: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
const decodeIdentityBody = Schema.decodeUnknownOption(IdentityBody);

export type FeadsIdentityOutcome =
  | { readonly ok: true; readonly actor: string }
  | { readonly ok: false; readonly error: string };

/**
 * Reads the actor out of any bearer-authenticated feads response. A 401 is the
 * token being unknown (`not_identified`); other non-2xx codes become
 * `http_<status>`; a 2xx without an actor is a server we do not understand.
 */
export function decodeFeadsIdentity(status: number, json: unknown): FeadsIdentityOutcome {
  const body = decodeIdentityBody(json);
  if (status === 401 || status === 403) {
    const error = body._tag === "Some" ? nonEmpty(body.value.error) : null;
    return { ok: false, error: error ?? "not_identified" };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, error: `http_${status}` };
  }
  if (body._tag === "Some" && body.value.ok !== false) {
    const actor = nonEmpty(body.value.actor);
    if (actor) return { ok: true, actor };
  }
  return {
    ok: false,
    error: body._tag === "Some" ? (nonEmpty(body.value.error) ?? "no_actor") : "not_json",
  };
}

/** Never let a token leak through an error string; feads tokens all start with `fdsa_`. */
export function redactFeadsSecrets(text: string): string {
  return text.replace(/fdsa_[A-Za-z0-9_-]+/g, "fdsa_…");
}
