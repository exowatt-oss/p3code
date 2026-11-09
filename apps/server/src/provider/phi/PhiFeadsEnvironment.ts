/**
 * Exowatt: the feads Agentwatch credential P3 hands to Phi. Phi publishes runtime presence only with
 * a token in its own environment (`FEADS_AGENT_TOKEN`/legacy `FEADS_TOKEN`, silent on `PI_NO_FEADS=1`),
 * so P3's Settings token must be overlaid per spawn. Pure env assembly: never logs the token.
 */

/** Canonical name Phi reads the presence credential from. */
export const FEADS_AGENT_TOKEN_ENV = "FEADS_AGENT_TOKEN";
/** Older name Phi still accepts; only ever read, never written. */
export const LEGACY_FEADS_TOKEN_ENV = "FEADS_TOKEN";
/** Base URL Phi PUTs presence rows to; it defaults to the hosted feads. */
export const FEADS_URL_ENV = "FEADS_URL";
/** Phi's kill switch for every feads extension behaviour. */
export const PI_NO_FEADS_ENV = "PI_NO_FEADS";
/** Lets feads tell a P3-launched runtime apart from a bare `phi` in a terminal. */
export const PHI_CLIENT_ENV = "PHI_CLIENT";
export const PHI_CLIENT_P3 = "p3";

/** The token/URL P3's own feads integration resolved (token included). */
export interface P3FeadsCredential {
  readonly token: string | null;
  readonly baseUrl: string | null;
}

const nonEmpty = (value: string | undefined | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * `PI_NO_FEADS=1` is the documented form, but anything truthy a user exports to
 * turn feads off should be honoured rather than argued with.
 */
export function phiFeadsDisabled(environment: Readonly<NodeJS.ProcessEnv>): boolean {
  const value = nonEmpty(environment[PI_NO_FEADS_ENV])?.toLowerCase();
  return value !== undefined && value !== "0" && value !== "false";
}

/**
 * Feads overlay for a Phi spawn. Token: P3's configured token -> `FEADS_AGENT_TOKEN` -> legacy
 * `FEADS_TOKEN`, published under the canonical name; `FEADS_URL` only when known. `PHI_CLIENT` is
 * always announced unless the user set one (it carries no secret).
 */
export function phiFeadsEnvironment(input: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly p3Feads?: P3FeadsCredential | undefined;
}): NodeJS.ProcessEnv {
  const { environment, p3Feads } = input;
  const overlay: NodeJS.ProcessEnv = {};
  if (nonEmpty(environment[PHI_CLIENT_ENV]) === undefined) {
    overlay[PHI_CLIENT_ENV] = PHI_CLIENT_P3;
  }
  // Phi disables presence itself, but forwarding a credential it was told not
  // to use is pointless risk surface.
  if (phiFeadsDisabled(environment)) return overlay;

  const token =
    nonEmpty(p3Feads?.token) ??
    nonEmpty(environment[FEADS_AGENT_TOKEN_ENV]) ??
    nonEmpty(environment[LEGACY_FEADS_TOKEN_ENV]);
  if (token === undefined) return overlay;
  overlay[FEADS_AGENT_TOKEN_ENV] = token;

  const baseUrl = nonEmpty(p3Feads?.baseUrl) ?? nonEmpty(environment[FEADS_URL_ENV]);
  if (baseUrl !== undefined) overlay[FEADS_URL_ENV] = baseUrl;
  return overlay;
}
