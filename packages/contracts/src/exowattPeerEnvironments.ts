// Exowatt distro: links to the user's other P3 environments, so the Threads MCP tools can reach
// a linked environment's threads by `environmentId`. The desktop's link reconciler writes them
// over `PUT /api/exowatt/peer-environments`; the bearer token never comes back out.
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExowattPeerInbound } from "./settings.ts";

/**
 * Client label prefix of the bearer session a desktop mints on a peer for a link. The peer
 * accepts such a session only on `/mcp`, for the cross-environment Threads tools.
 */
export const EXOWATT_PEER_SESSION_LABEL_PREFIX = "p3-peer:";

/** Whether a stored session client label marks a linked environment's session, forward or reverse. */
export const isExowattPeerSessionLabel = (label: string | undefined): boolean =>
  label?.startsWith(EXOWATT_PEER_SESSION_LABEL_PREFIX) === true;

/**
 * Reverse-link label prefix: the primary's session for a link B minted, stored on B (less
 * trusted; grants access back to the primary). Only this direction is bounded by the receiver's
 * `exowattPeerInbound` gate; a forward bearer never leaves its minting server, so gating it
 * there protects nothing. Chosen only by a minter with operate scope on the receiver.
 */
export const EXOWATT_REVERSE_PEER_SESSION_LABEL_PREFIX = `${EXOWATT_PEER_SESSION_LABEL_PREFIX}reverse `;

/** Whether a stored session client label marks a reverse link's session, gated by this server's inbound setting. */
export const isExowattReversePeerSessionLabel = (label: string | undefined): boolean =>
  label?.startsWith(EXOWATT_REVERSE_PEER_SESSION_LABEL_PREFIX) === true;

/** One label per source environment, so re-linking can find and revoke the previous session. */
export const exowattPeerSessionLabel = (source: {
  readonly label: string;
  readonly environmentId: string;
}): string => `${EXOWATT_PEER_SESSION_LABEL_PREFIX}${source.label} (${source.environmentId})`;

/**
 * Phrase in a link's `lastError` once the peer rejected its bearer (401): the session expired or
 * was revoked, so the desktop must mint a fresh one rather than keep the dead link.
 */
export const EXOWATT_PEER_LINK_REVOKED_PHRASE = "expired or was revoked";

/** Upsert body. `token` is a bearer session on the peer scoped to orchestration read/operate. */
export const ExowattPeerEnvironmentLinkInput = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /**
   * The peer's HTTP origin as this server reaches it, e.g. `http://127.0.0.1:41234`, or
   * `unix:<path>` for an SSH-forwarded socket in this server's own `<T3 home>/peer/`.
   */
  httpBaseUrl: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ExowattPeerEnvironmentLinkInput = typeof ExowattPeerEnvironmentLinkInput.Type;

/** A stored link as the API and tools show it: never the token. */
export const ExowattPeerEnvironmentLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  /** The last call's failure, cleared by the next successful call. */
  lastError: Schema.NullOr(Schema.String),
});
export type ExowattPeerEnvironmentLink = typeof ExowattPeerEnvironmentLink.Type;

export const ExowattPeerEnvironmentList = Schema.Struct({
  /** Server setting `exowattCrossEnvironmentAgentTools`. Off means `links` is empty. */
  enabled: Schema.Boolean,
  links: Schema.Array(ExowattPeerEnvironmentLink),
  /** Server setting `exowattPeerInbound`; absent from older builds, which a client treats as off. */
  inbound: Schema.optionalKey(ExowattPeerInbound),
});
export type ExowattPeerEnvironmentList = typeof ExowattPeerEnvironmentList.Type;

export const ExowattPeerEnvironmentParams = Schema.Struct({
  environmentId: EnvironmentId,
});

export const ExowattPeerEnvironmentRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type ExowattPeerEnvironmentRemoveResult = typeof ExowattPeerEnvironmentRemoveResult.Type;
