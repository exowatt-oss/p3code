import type {
  EnvironmentId,
  ExowattPeerEnvironmentLink,
  ExowattPeerInbound,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orphanReverseSessions,
  peerLinkCandidatesKey,
  peerSessionsToRevoke,
  planPeerEnvironmentLinks,
  planReversePeerLink,
  reversePeerSessionLabel,
  type PeerLinkCandidate,
} from "./peerEnvironmentLinks";

const primary = "primary" as EnvironmentId;
const ssh = "ssh" as EnvironmentId;
const paired = "paired" as EnvironmentId;
const relay = "relay" as EnvironmentId;
const now = Date.parse("2026-10-30T00:00:00.000Z");
const expiry = (days: number) => new Date(now + days * 24 * 60 * 60 * 1_000).toISOString();
const candidate = (
  environmentId: EnvironmentId,
  overrides: Partial<PeerLinkCandidate> = {},
): PeerLinkCandidate => ({
  environmentId,
  label: environmentId,
  eligible: true,
  connected: true,
  httpBaseUrl: "http://127.0.0.1:4000",
  bearer: true,
  reverseHttpBaseUrl: null,
  peerLinkingEnabled: true,
  peerInbound: "full-access",
  ...overrides,
});
const link = (
  environmentId: EnvironmentId,
  expiresAt = expiry(8),
  httpBaseUrl = "http://127.0.0.1:4000",
): ExowattPeerEnvironmentLink => ({
  environmentId,
  label: environmentId,
  httpBaseUrl,
  linkedAt: expiry(-1),
  expiresAt,
  lastError: null,
});

const plan = (
  candidates: ReadonlyArray<PeerLinkCandidate>,
  links: ReadonlyArray<ExowattPeerEnvironmentLink>,
  catalogReady = true,
) =>
  planPeerEnvironmentLinks({
    primaryEnvironmentId: primary,
    catalogReady,
    candidates,
    links,
    now,
  });

describe("desktop peer environment link planning", () => {
  it("re-links a link whose session the peer rejected, but not one with another error", () => {
    const revoked = {
      ...link(ssh),
      lastError: "link to ssh expired or was revoked; reopen the P3 desktop app to re-link",
    };
    const unreachable = { ...link(paired), lastError: "environment paired is unreachable (x)" };
    expect(
      plan([candidate(ssh), candidate(paired)], [revoked, unreachable]).upsert.map(
        (entry) => entry.environmentId,
      ),
    ).toEqual([ssh]);
  });

  it("keys the reconciler only on what a link depends on", () => {
    const base = { isReady: true, candidates: [candidate(ssh)] };
    // Same link-relevant state with a different object identity and a non-canonical URL.
    expect(
      peerLinkCandidatesKey({
        isReady: true,
        candidates: [candidate(ssh, { httpBaseUrl: "http://127.0.0.1:4000/" })],
      }),
    ).toBe(peerLinkCandidatesKey(base));
    expect(
      peerLinkCandidatesKey({ isReady: true, candidates: [candidate(ssh, { connected: false })] }),
    ).not.toBe(peerLinkCandidatesKey(base));
  });

  it("links only connected bearer SSH or paired remote candidates", () => {
    expect(
      plan(
        [
          candidate(primary),
          candidate(ssh),
          candidate(paired),
          candidate(relay, { eligible: false }),
          candidate("cookie" as EnvironmentId, { bearer: false }),
          candidate("offline" as EnvironmentId, { connected: false }),
        ],
        [],
      ),
    ).toEqual({ upsert: [candidate(ssh), candidate(paired)], remove: [] });
  });

  it("keeps valid links, renews when fewer than seven days remain or tunnel URL moves", () => {
    const sshMoved = candidate(ssh, { httpBaseUrl: "http://127.0.0.1:5000/" });
    expect(plan([sshMoved, candidate(paired)], [link(ssh), link(paired, expiry(6))])).toEqual({
      upsert: [sshMoved, candidate(paired)],
      remove: [],
    });
    expect(plan([candidate(ssh)], [link(ssh, expiry(7))])).toEqual({ upsert: [], remove: [] });
    expect(plan([candidate(ssh, { connected: false })], [link(ssh, expiry(2))])).toEqual({
      upsert: [],
      remove: [],
    });
  });

  it("keeps a link while its environment is disconnected or not yet prepared", () => {
    const disconnected = candidate(ssh, { connected: false, bearer: false, httpBaseUrl: null });
    expect(plan([disconnected], [link(ssh)])).toEqual({ upsert: [], remove: [] });
  });

  it("removes a link when its saved environment is deleted", () => {
    expect(plan([candidate(paired)], [link(ssh), link(paired)])).toEqual({
      upsert: [],
      remove: [ssh],
    });
  });

  it("removes a link when the saved target type stops being SSH or bearer", () => {
    expect(plan([candidate(ssh, { eligible: false })], [link(ssh)])).toEqual({
      upsert: [],
      remove: [ssh],
    });
  });

  it("compares a link against the candidate's origin, so a non-canonical URL doesn't re-mint", () => {
    expect(
      plan(
        [candidate(ssh, { httpBaseUrl: "HTTP://127.0.0.1:4000//" }), candidate(paired)],
        [link(ssh), link(paired, expiry(8), "https://devbox.example")],
      ),
    ).toEqual({ upsert: [candidate(paired)], remove: [] });
    expect(
      plan(
        [candidate(paired, { httpBaseUrl: "https://devbox.example:443/" })],
        [link(paired, expiry(8), "https://devbox.example")],
      ),
    ).toEqual({ upsert: [], remove: [] });
  });

  it("never mints for an environment served below a path", () => {
    const subPath = candidate(ssh, { httpBaseUrl: "https://gateway.example/p3" });
    expect(plan([subPath], [])).toEqual({ upsert: [], remove: [] });
    expect(plan([subPath], [link(ssh, expiry(8), "https://gateway.example")])).toEqual({
      upsert: [],
      remove: [],
    });
  });

  it("does nothing during catalog hydration", () => {
    expect(plan([], [link(ssh), link(paired)], false)).toEqual({ upsert: [], remove: [] });
  });

  it("links into a candidate regardless of its own inbound setting, forward is never gated by it", () => {
    // Off, unreadable, or simply absent from an older build that predates reverse links: none of
    // these may withhold or cut a forward link. Only this primary's own outbound setting
    // (reflected in `eligible`/`canLinkNow`, not here) gates the forward direction.
    expect(
      plan([candidate(ssh, { peerInbound: "off" }), candidate(paired, { peerInbound: null })], [])
        .upsert,
    ).toEqual([candidate(ssh, { peerInbound: "off" }), candidate(paired, { peerInbound: null })]);
    // A live link into a candidate that just turned its own inbound off is kept, not cut.
    expect(
      plan(
        [candidate(ssh, { peerInbound: "off" }), candidate(paired, { peerInbound: null })],
        [link(ssh), link(paired)],
      ),
    ).toEqual({ upsert: [], remove: [] });
  });

  it("revokes this primary's earlier peer sessions by environment id, even after a rename", () => {
    expect(
      peerSessionsToRevoke(
        [
          { sessionId: "old", current: false, client: { label: "p3-peer:Mac (primary)" } },
          { sessionId: "renamed", current: false, client: { label: "p3-peer:Old Mac (primary)" } },
          { sessionId: "desktop", current: true, client: { label: "p3-peer:Mac (primary)" } },
          { sessionId: "other-mac", current: false, client: { label: "p3-peer:Mac (other)" } },
          { sessionId: "lookalike", current: false, client: { label: "Mac (primary)" } },
          { sessionId: "browser", current: false, client: {} },
        ],
        primary,
      ),
    ).toEqual(["old", "renamed"]);
  });

  it("picks reverse sessions by id and revokes those of environments gone from the catalog", () => {
    const clients = [
      {
        sessionId: "rev-ssh",
        current: false,
        client: { label: reversePeerSessionLabel(candidate(ssh)) },
      },
      {
        sessionId: "rev-gone",
        current: false,
        client: {
          label: reversePeerSessionLabel({
            label: "old box",
            environmentId: "gone" as EnvironmentId,
          }),
        },
      },
      { sessionId: "forward-from-c", current: false, client: { label: "p3-peer:Laptop C (gone)" } },
    ];
    expect(peerSessionsToRevoke(clients, ssh, { reverse: true })).toEqual(["rev-ssh"]);
    expect(orphanReverseSessions(clients, new Set([primary, ssh]))).toEqual(["rev-gone"]);
  });
});

describe("desktop reverse peer link planning", () => {
  const SOCKET = "unix:/home/dev/.t3/peer/primary-0a1b2c3d.sock";
  const reverse = (overrides: Partial<PeerLinkCandidate> = {}) =>
    candidate(ssh, { reverseHttpBaseUrl: SOCKET, ...overrides });
  const primaryLink = (expiresAt = expiry(8), httpBaseUrl = SOCKET) =>
    link(primary, expiresAt, httpBaseUrl);
  const planReverse = (
    entry: PeerLinkCandidate,
    remote: { enabled: boolean; links: ReadonlyArray<ExowattPeerEnvironmentLink> } | null,
    localInbound: ExowattPeerInbound = "full-access",
  ) =>
    planReversePeerLink({
      primaryEnvironmentId: primary,
      candidate: entry,
      remote,
      localInbound,
      now,
    });

  it("links a connected SSH remote that has a reverse socket and no link to this primary", () => {
    expect(planReverse(reverse(), { enabled: true, links: [link(paired)] })).toBe("link");
  });

  it("keeps a live link at the current reverse socket", () => {
    expect(planReverse(reverse(), { enabled: true, links: [primaryLink()] })).toBe("keep");
  });

  it("re-links when the socket moved, expiry is near, or the session was revoked", () => {
    expect(
      planReverse(reverse({ reverseHttpBaseUrl: "unix:/home/dev/.t3/peer/primary-ffff.sock" }), {
        enabled: true,
        links: [primaryLink()],
      }),
    ).toBe("link");
    expect(planReverse(reverse(), { enabled: true, links: [primaryLink(expiry(6))] })).toBe("link");
    expect(
      planReverse(reverse(), {
        enabled: true,
        links: [{ ...primaryLink(), lastError: "link to Mac expired or was revoked; reopen" }],
      }),
    ).toBe("link");
  });

  it("retires the link while the remote's outbound or this primary's inbound is off", () => {
    expect(planReverse(reverse(), { enabled: false, links: [] })).toBe("retire");
    expect(planReverse(reverse(), { enabled: true, links: [primaryLink()] }, "off")).toBe("retire");
    // Inbound off retires even without a readable list or route: the session lives here.
    expect(planReverse(reverse({ reverseHttpBaseUrl: null }), null, "off")).toBe("retire");
  });

  it("skips without a reverse socket, connection, readable link list, or for the primary", () => {
    const remote = { enabled: true, links: [] };
    expect(planReverse(reverse({ reverseHttpBaseUrl: null }), remote)).toBe("skip");
    expect(planReverse(reverse({ reverseHttpBaseUrl: "http://127.0.0.1:41000" }), remote)).toBe(
      "skip",
    );
    expect(planReverse(reverse({ connected: false }), remote)).toBe("skip");
    expect(planReverse(reverse({ bearer: false }), remote)).toBe("skip");
    expect(planReverse(reverse(), null)).toBe("skip");
    expect(planReverse(candidate(primary, { reverseHttpBaseUrl: SOCKET }), remote)).toBe("skip");
  });

  it("re-reconciles when the reverse route or the remote's settings change", () => {
    const base = { isReady: true, candidates: [reverse()] };
    for (const changed of [
      reverse({ reverseHttpBaseUrl: "unix:/home/dev/.t3/peer/primary-ffff.sock" }),
      reverse({ peerLinkingEnabled: false }),
      reverse({ peerInbound: "off" }),
    ]) {
      expect(peerLinkCandidatesKey({ isReady: true, candidates: [changed] })).not.toBe(
        peerLinkCandidatesKey(base),
      );
    }
  });
});
