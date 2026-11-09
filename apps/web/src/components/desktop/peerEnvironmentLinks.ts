import {
  type EnvironmentId,
  EXOWATT_PEER_LINK_REVOKED_PHRASE,
  EXOWATT_PEER_SESSION_LABEL_PREFIX,
  EXOWATT_REVERSE_PEER_SESSION_LABEL_PREFIX,
  type ExowattPeerEnvironmentLink,
  type ExowattPeerEnvironmentList,
  type ExowattPeerInbound,
  exowattPeerSessionLabel,
} from "@t3tools/contracts";

const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface PeerLinkCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** From the saved catalog entry's target type (SSH or bearer-paired), not the live connection. */
  readonly eligible: boolean;
  readonly connected: boolean;
  /** The live prepared connection's origin, null while there is none. */
  readonly httpBaseUrl: string | null;
  /** Whether the live prepared connection holds a bearer session. */
  readonly bearer: boolean;
  /** This desktop's primary as the candidate reaches it (`unix:` SSH reverse socket), or null. */
  readonly reverseHttpBaseUrl: string | null;
  /** The candidate's own `exowattCrossEnvironmentAgentTools`, as last seen; flipping it re-reconciles. */
  readonly peerLinkingEnabled: boolean;
  /** The candidate's own `exowattPeerInbound`, as last seen; changing it re-reconciles. */
  readonly peerInbound: ExowattPeerInbound | null;
}

/** A `unix:<absolute path>.sock` reverse route as the remote stores it, or null. */
export function reverseLinkTarget(reverseHttpBaseUrl: string | null): string | null {
  return reverseHttpBaseUrl !== null && /^unix:\/[^\s]+\.sock$/u.test(reverseHttpBaseUrl)
    ? reverseHttpBaseUrl
    : null;
}

/** The primary's session for B's reverse link, marked so orphans can be told from other links. */
export const reversePeerSessionLabel = (source: {
  readonly label: string;
  readonly environmentId: EnvironmentId;
}) =>
  exowattPeerSessionLabel({
    label: `reverse ${source.label}`,
    environmentId: source.environmentId,
  });

/**
 * The origin a link stores for this URL, or null when the environment is served below a path:
 * links are origin-only (the peer's `/mcp`), so a sub-path environment can't be linked.
 */
export function peerLinkOrigin(httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  if (!/^\/*$/.test(parsed.pathname) || parsed.search !== "" || parsed.hash !== "") return null;
  return parsed.origin;
}

/** A candidate this desktop can mint a peer session on right now. */
export const canLinkNow = (candidate: PeerLinkCandidate): boolean =>
  candidate.eligible &&
  candidate.connected &&
  candidate.bearer &&
  peerLinkOrigin(candidate.httpBaseUrl) !== null;

/** A stored link that should be minted afresh for this origin. */
function linkNeedsRenewal(
  link: ExowattPeerEnvironmentLink | undefined,
  origin: string | null,
  now: number,
): boolean {
  return (
    !link ||
    link.httpBaseUrl !== origin ||
    link.lastError?.includes(EXOWATT_PEER_LINK_REVOKED_PHRASE) === true ||
    Date.parse(link.expiresAt) - now < RENEW_BEFORE_MS
  );
}

/**
 * Upsert only while connected with a bearer; remove only when the saved entry is gone or its
 * target type is no longer eligible, never on a mere disconnect or app launch. This is the
 * *forward* direction, gated only by this primary's own outbound setting: the candidate's own
 * `exowattPeerInbound` (off, unreadable, or absent on an older build) must never cut or withhold it.
 */
export function planPeerEnvironmentLinks(input: {
  readonly primaryEnvironmentId: EnvironmentId;
  readonly catalogReady: boolean;
  readonly candidates: ReadonlyArray<PeerLinkCandidate>;
  readonly links: ReadonlyArray<ExowattPeerEnvironmentLink>;
  readonly now: number;
}): {
  readonly upsert: ReadonlyArray<PeerLinkCandidate>;
  readonly remove: ReadonlyArray<EnvironmentId>;
} {
  if (!input.catalogReady) return { upsert: [], remove: [] };
  const eligible = (candidate: PeerLinkCandidate | undefined) =>
    candidate !== undefined &&
    candidate.environmentId !== input.primaryEnvironmentId &&
    candidate.eligible;
  const byId = new Map(input.candidates.map((candidate) => [candidate.environmentId, candidate]));
  const links = new Map(input.links.map((link) => [link.environmentId, link]));
  return {
    upsert: input.candidates.filter((candidate) => {
      if (!eligible(candidate) || !canLinkNow(candidate)) return false;
      return linkNeedsRenewal(
        links.get(candidate.environmentId),
        peerLinkOrigin(candidate.httpBaseUrl),
        input.now,
      );
    }),
    remove: input.links
      .filter((link) => !eligible(byId.get(link.environmentId)))
      .map((link) => link.environmentId),
  };
}

/**
 * The reverse link (B reaching this primary A over the SSH reverse socket): `link` mints on A
 * and stores on B; `retire` revokes A's session and drops B's link because A's inbound or B's
 * outbound setting is off; `keep` leaves a live link; `skip` means no route or no readable
 * list. A disconnect is `skip`: the next connection's socket name differs, which re-links.
 */
export function planReversePeerLink(input: {
  readonly primaryEnvironmentId: EnvironmentId;
  readonly candidate: PeerLinkCandidate;
  /** B's `GET /api/exowatt/peer-environments`, null when it failed (e.g. an older build). */
  readonly remote: ExowattPeerEnvironmentList | null;
  /** This primary's own `exowattPeerInbound`. */
  readonly localInbound: ExowattPeerInbound;
  readonly now: number;
}): "link" | "retire" | "keep" | "skip" {
  const { candidate } = input;
  if (candidate.environmentId === input.primaryEnvironmentId || !canLinkNow(candidate)) {
    return "skip";
  }
  if (input.localInbound === "off") return "retire";
  const origin = reverseLinkTarget(candidate.reverseHttpBaseUrl);
  if (origin === null || input.remote === null) return "skip";
  if (!input.remote.enabled) return "retire";
  const link = input.remote.links.find(
    (entry) => entry.environmentId === input.primaryEnvironmentId,
  );
  return linkNeedsRenewal(link, origin, input.now) ? "link" : "keep";
}

type ClientSession = {
  readonly sessionId: string;
  readonly current: boolean;
  readonly client: { readonly label?: string };
};

const sourceEnvironmentOf = (label: string | undefined) =>
  /\(([^()\s]+)\)$/u.exec(label ?? "")?.[1] ?? null;

/**
 * The peer sessions minted for links from `environmentId`, matched by the label's prefix and
 * its ` (<environmentId>)` suffix so a renamed environment's old session still matches. Never
 * the caller's own current session. `reverse` picks the primary's reverse-link sessions.
 */
export function peerSessionsToRevoke<Session extends ClientSession>(
  clients: ReadonlyArray<Session>,
  environmentId: EnvironmentId,
  options: { readonly reverse?: boolean } = {},
): ReadonlyArray<Session["sessionId"]> {
  const prefix =
    options.reverse === true
      ? EXOWATT_REVERSE_PEER_SESSION_LABEL_PREFIX
      : EXOWATT_PEER_SESSION_LABEL_PREFIX;
  return clients
    .filter(
      (entry) =>
        !entry.current &&
        entry.client.label?.startsWith(prefix) === true &&
        sourceEnvironmentOf(entry.client.label) === environmentId,
    )
    .map((entry) => entry.sessionId);
}

/** The primary's reverse-link sessions for environments no longer in the saved catalog. */
export function orphanReverseSessions<Session extends ClientSession>(
  clients: ReadonlyArray<Session>,
  catalogIds: ReadonlySet<string>,
): ReadonlyArray<Session["sessionId"]> {
  return clients
    .filter((entry) => {
      if (
        entry.current ||
        entry.client.label?.startsWith(EXOWATT_REVERSE_PEER_SESSION_LABEL_PREFIX) !== true
      ) {
        return false;
      }
      const source = sourceEnvironmentOf(entry.client.label);
      return source !== null && !catalogIds.has(source);
    })
    .map((entry) => entry.sessionId);
}

/**
 * What the reconciler acts on. The candidates atom yields a new object whenever any connection's
 * presentation changes; keying on this string keeps the reconcile effect from restarting (and
 * cancelling an in-flight mint) when nothing a link depends on changed.
 */
export function peerLinkCandidatesKey(input: {
  readonly isReady: boolean;
  readonly candidates: ReadonlyArray<PeerLinkCandidate>;
}): string {
  return JSON.stringify([
    input.isReady,
    input.candidates.map((candidate) => [
      candidate.environmentId,
      candidate.label,
      candidate.eligible,
      canLinkNow(candidate),
      peerLinkOrigin(candidate.httpBaseUrl),
      reverseLinkTarget(candidate.reverseHttpBaseUrl),
      candidate.peerLinkingEnabled,
      candidate.peerInbound,
    ]),
  ]);
}
