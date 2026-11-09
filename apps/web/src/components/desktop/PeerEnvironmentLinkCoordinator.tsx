import { useAtomValue } from "@effect/atom-react";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environment-http-auth";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthClientSession,
  type AuthSessionId,
  type EnvironmentId,
  type ExowattPeerEnvironmentLinkInput,
  type ExowattPeerEnvironmentList,
  exowattPeerSessionLabel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { runPrimaryHttp, runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { environmentSession, readPreparedConnection } from "../../state/session";
import {
  canLinkNow,
  orphanReverseSessions,
  peerLinkCandidatesKey,
  peerLinkOrigin,
  peerSessionsToRevoke,
  planPeerEnvironmentLinks,
  planReversePeerLink,
  reverseLinkTarget,
  reversePeerSessionLabel,
  type PeerLinkCandidate,
} from "./peerEnvironmentLinks";

const PEER_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const candidatesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const candidates: PeerLinkCandidate[] = [...catalog.entries].map(([environmentId, entry]) => {
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    const settings = get(serverEnvironment.configValueAtom(environmentId))?.settings;
    return {
      environmentId,
      label: entry.target.label,
      eligible:
        entry.target._tag === "SshConnectionTarget" ||
        entry.target._tag === "BearerConnectionTarget",
      connected:
        get(environmentPresentations.presentationAtom(environmentId))?.connection.phase ===
        "connected",
      httpBaseUrl: prepared?.httpBaseUrl ?? null,
      bearer: prepared?.httpAuthorization?._tag === "Bearer",
      reverseHttpBaseUrl: prepared?.reverseHttpBaseUrl ?? null,
      peerLinkingEnabled: settings?.exowattCrossEnvironmentAgentTools === true,
      peerInbound: settings?.exowattPeerInbound ?? null,
    };
  });
  return { isReady: catalog.isReady, candidates };
}).pipe(Atom.withLabel("web-peer-environment-link-candidates"));

function primaryPeers() {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.exowattPeerEnvironments.list({ headers: {} })),
    ),
  );
}

function removePrimaryPeer(environmentId: EnvironmentId) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.exowattPeerEnvironments.remove({ headers: {}, params: { environmentId } }),
      ),
    ),
  );
}

function upsertPrimaryPeer(input: {
  environmentId: EnvironmentId;
  label: string;
  httpBaseUrl: string;
  token: string;
  expiresAt: string;
}) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.exowattPeerEnvironments.upsert({ headers: {}, payload: input }),
      ),
    ),
  );
}

function bearerConnection(environmentId: EnvironmentId) {
  const prepared = readPreparedConnection(environmentId);
  return prepared?.httpAuthorization?._tag === "Bearer" ? prepared : null;
}

/** Best effort: revoke this primary's peer sessions on B, so at most one stays live. */
async function revokePeerSessions(environmentId: EnvironmentId, primaryId: EnvironmentId) {
  const prepared = bearerConnection(environmentId);
  if (!prepared) return;
  try {
    const clients = await runtime.runPromise(
      executeAuthenticatedEnvironmentHttpRequest({
        prepared,
        signer: Option.none(),
        group: "auth",
        method: "GET",
        url: (urls) => urls.clients(),
        timeoutMs: 8_000,
        request: ({ client, headers }) => client.clients({ headers }),
      }),
    );
    for (const sessionId of peerSessionsToRevoke(clients, primaryId)) {
      await runtime.runPromise(
        executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer: Option.none(),
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeClient(),
          timeoutMs: 8_000,
          request: ({ client, headers }) =>
            client.revokeClient({ headers, payload: { sessionId } }),
        }),
      );
    }
  } catch {
    // Typed API errors may contain request details. Never log a bearer.
    console.debug("Peer environment session revocation skipped", environmentId);
  }
}

async function mintPeerSession(
  candidate: PeerLinkCandidate,
  peerLabel: string,
  primaryId: EnvironmentId,
) {
  const prepared = bearerConnection(candidate.environmentId);
  if (!prepared || prepared.httpBaseUrl !== candidate.httpBaseUrl) return null;
  await revokePeerSessions(candidate.environmentId, primaryId);
  const pairing = await runtime.runPromise(
    executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer: Option.none(),
      group: "auth",
      method: "POST",
      url: (urls) => urls.pairingCredential(),
      timeoutMs: 8_000,
      request: ({ client, headers }) =>
        client.pairingCredential({
          headers,
          payload: { label: peerLabel, scopes: [...PEER_SCOPES] },
        }),
    }),
  );
  const session = await runtime.runPromise(
    bootstrapRemoteBearerSession({
      httpBaseUrl: prepared.httpBaseUrl,
      credential: pairing.credential,
      scopes: PEER_SCOPES,
    }),
  );
  if (
    session.token_type !== "Bearer" ||
    !Number.isFinite(session.expires_in) ||
    session.expires_in <= 0
  )
    return null;
  return {
    environmentId: candidate.environmentId,
    label: candidate.label,
    httpBaseUrl: peerLinkOrigin(candidate.httpBaseUrl)!,
    token: session.access_token,
    expiresAt: new Date(Date.now() + session.expires_in * 1_000).toISOString(),
  };
}

// Reverse links: B (an SSH remote) reaches this desktop's primary A over the tunnel's reverse
// socket. The session is minted on A and stored on B, mirroring the forward direction.

/** Best effort: revoke A's reverse-link sessions picked from its client list. */
async function revokePrimarySessions(
  pick: (clients: ReadonlyArray<AuthClientSession>) => ReadonlyArray<AuthSessionId>,
) {
  try {
    const clients = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.clients({ headers: {} })),
      ),
    );
    for (const sessionId of pick(clients)) {
      await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.auth.revokeClient({ headers: {}, payload: { sessionId } }),
          ),
        ),
      );
    }
  } catch {
    console.debug("Reverse peer session revocation skipped");
  }
}

/** A's sessions for B's reverse link, so at most one stays live. */
const revokePrimaryPeerSessions = (environmentId: EnvironmentId) =>
  revokePrimarySessions((clients) =>
    peerSessionsToRevoke(clients, environmentId, { reverse: true }),
  );

async function mintPrimaryPeerSession(candidate: PeerLinkCandidate) {
  const label = reversePeerSessionLabel(candidate);
  await revokePrimaryPeerSessions(candidate.environmentId);
  const pairing = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.auth.pairingCredential({
          headers: {},
          payload: { label, scopes: [...PEER_SCOPES] },
        }),
      ),
    ),
  );
  const session = await runtime.runPromise(
    bootstrapRemoteBearerSession({
      httpBaseUrl: resolvePrimaryEnvironmentHttpUrl("/"),
      credential: pairing.credential,
      scopes: PEER_SCOPES,
    }),
  );
  if (
    session.token_type !== "Bearer" ||
    !Number.isFinite(session.expires_in) ||
    session.expires_in <= 0
  ) {
    await revokePrimaryPeerSessions(candidate.environmentId);
    return null;
  }
  return {
    token: session.access_token,
    expiresAt: new Date(Date.now() + session.expires_in * 1_000).toISOString(),
  };
}

function remotePeers(environmentId: EnvironmentId) {
  const prepared = bearerConnection(environmentId);
  if (!prepared) return Promise.resolve(null);
  return runtime
    .runPromise(
      executeAuthenticatedEnvironmentHttpRequest({
        prepared,
        signer: Option.none(),
        group: "exowattPeerEnvironments",
        method: "GET",
        url: (urls) => urls.list(),
        timeoutMs: 8_000,
        request: ({ client, headers }) => client.list({ headers }),
      }),
    )
    .catch(() => null);
}

function upsertRemotePeer(environmentId: EnvironmentId, payload: ExowattPeerEnvironmentLinkInput) {
  const prepared = bearerConnection(environmentId);
  if (!prepared) return Promise.reject(new Error("no bearer connection"));
  return runtime.runPromise(
    executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer: Option.none(),
      group: "exowattPeerEnvironments",
      method: "PUT",
      url: (urls) => urls.upsert(),
      timeoutMs: 8_000,
      request: ({ client, headers }) => client.upsert({ headers, payload }),
    }),
  );
}

/** Best effort: drop B's stored link to the primary. */
async function removeRemotePeer(environmentId: EnvironmentId, primaryId: EnvironmentId) {
  const prepared = bearerConnection(environmentId);
  if (!prepared) return;
  await runtime
    .runPromise(
      executeAuthenticatedEnvironmentHttpRequest({
        prepared,
        signer: Option.none(),
        group: "exowattPeerEnvironments",
        method: "DELETE",
        url: (urls) => urls.remove({ params: { environmentId: primaryId } }),
        timeoutMs: 8_000,
        request: ({ client, headers }) =>
          client.remove({ headers, params: { environmentId: primaryId } }),
      }),
    )
    .catch(() => {
      console.debug("Reverse peer link removal skipped", environmentId);
    });
}

/**
 * Mint a session on the primary for B and store it on B; never throws. Same policy as
 * `linkCandidate`: a minted session is revoked only when it can't be stored.
 */
async function reverseLinkCandidate(
  candidate: PeerLinkCandidate,
  primary: { readonly environmentId: EnvironmentId; readonly label: string },
): Promise<"continue" | "stop"> {
  const session = await mintPrimaryPeerSession(candidate).catch(() => null);
  if (!session) return "continue";
  if (!inboundEnabled()) {
    await revokePrimaryPeerSessions(candidate.environmentId);
    return "stop";
  }
  const stored = await upsertRemotePeer(candidate.environmentId, {
    environmentId: primary.environmentId,
    label: primary.label,
    httpBaseUrl: reverseLinkTarget(candidate.reverseHttpBaseUrl)!,
    ...session,
  }).then(
    () => true,
    () => false,
  );
  if (!stored) {
    await revokePrimaryPeerSessions(candidate.environmentId);
    console.debug("Reverse peer environment link skipped", candidate.environmentId);
  }
  return "continue";
}

const linkingEnabled = () =>
  appAtomRegistry.get(primaryServerSettingsAtom).exowattCrossEnvironmentAgentTools;
const localInbound = () => appAtomRegistry.get(primaryServerSettingsAtom).exowattPeerInbound;
const inboundEnabled = () => localInbound() !== "off";

/**
 * Mint a peer session on the candidate and hand it to the primary; never throws. A minted
 * session is revoked only when it can't be stored (setting turned off, primary refused it), never
 * because the desktop's connection state moved on meanwhile: that churn used to revoke every
 * session it minted, so no link ever stayed live.
 */
async function linkCandidate(
  candidate: PeerLinkCandidate,
  peerLabel: string,
  primaryId: EnvironmentId,
): Promise<"continue" | "stop"> {
  const link = await mintPeerSession(candidate, peerLabel, primaryId).catch(() => null);
  if (!link) return "continue";
  if (!linkingEnabled()) {
    await revokePeerSessions(candidate.environmentId, primaryId);
    return "stop";
  }
  const stored = await upsertPrimaryPeer(link).then(
    () => true,
    () => false,
  );
  if (!stored) {
    // Don't orphan the session just minted on B. Never log a pairing credential or bearer.
    await revokePeerSessions(candidate.environmentId, primaryId);
    console.debug("Peer environment link skipped", candidate.environmentId);
  }
  return "continue";
}

interface ReconcileInput {
  readonly primaryId: EnvironmentId;
  readonly catalog: {
    readonly isReady: boolean;
    readonly candidates: ReadonlyArray<PeerLinkCandidate>;
  };
  readonly peerLabel: string;
  readonly primaryLabel: string;
}

async function reconcilePeerLinks(input: ReconcileInput): Promise<void> {
  const { primaryId, catalog, peerLabel, primaryLabel } = input;
  const current = await primaryPeers().catch(() => null);
  if (current === null) {
    console.debug("Peer environment link reconciliation skipped");
    return;
  }
  if (current.enabled) {
    const plan = planPeerEnvironmentLinks({
      primaryEnvironmentId: primaryId,
      catalogReady: catalog.isReady,
      candidates: catalog.candidates,
      links: current.links,
      now: Date.now(),
    });
    for (const environmentId of plan.remove) {
      await removePrimaryPeer(environmentId).catch(() => {
        console.debug("Peer environment link removal skipped", environmentId);
      });
      await revokePeerSessions(environmentId, primaryId);
    }
    for (const candidate of plan.upsert) {
      if ((await linkCandidate(candidate, peerLabel, primaryId)) === "stop") return;
    }
  }
  // Each candidate's own answer is read only for the *reverse* route below, and only after the
  // forward links are done, so a slow or hung candidate never delays Mac→devbox linking (the
  // forward plan reads nothing from it). A wrong "off" here would cut a live reverse link.
  const remotes = new Map<EnvironmentId, ExowattPeerEnvironmentList | null>();
  for (const candidate of catalog.candidates) {
    if (candidate.environmentId === primaryId || !canLinkNow(candidate)) continue;
    remotes.set(candidate.environmentId, await remotePeers(candidate.environmentId));
  }
  // B is gone from the catalog, so its reverse session can only be cut on this side.
  if (catalog.isReady) {
    const catalogIds = new Set<string>(catalog.candidates.map((entry) => entry.environmentId));
    await revokePrimarySessions((clients) => orphanReverseSessions(clients, catalogIds));
  }
  for (const candidate of catalog.candidates) {
    const remote = remotes.get(candidate.environmentId) ?? null;
    const action = planReversePeerLink({
      primaryEnvironmentId: primaryId,
      candidate,
      remote,
      localInbound: localInbound(),
      now: Date.now(),
    });
    if (action === "retire") {
      await revokePrimaryPeerSessions(candidate.environmentId);
      if (remote?.links.some((link) => link.environmentId === primaryId) === true) {
        await removeRemotePeer(candidate.environmentId, primaryId);
      }
    }
    if (action !== "link") continue;
    const result = await reverseLinkCandidate(candidate, {
      environmentId: primaryId,
      label: primaryLabel,
    });
    if (result === "stop") return;
  }
}

/**
 * One reconcile at a time for the whole app. Overlapping runs each revoked the sessions the
 * other had just minted (revoke-before-mint matches by label). A request while one runs queues
 * exactly one follow-up, which reads the latest inputs when it starts.
 */
let reconcileRunning = false;
let reconcileQueued = false;
function requestReconcile(latest: () => ReconcileInput | null) {
  if (reconcileRunning) {
    reconcileQueued = true;
    return;
  }
  const input = latest();
  if (!input || !(linkingEnabled() || inboundEnabled())) return;
  reconcileRunning = true;
  void reconcilePeerLinks(input).finally(() => {
    reconcileRunning = false;
    if (reconcileQueued) {
      reconcileQueued = false;
      requestReconcile(latest);
    }
  });
}

/** Only the desktop host can hand the primary a route it can actually reach. */
export function PeerEnvironmentLinkCoordinator() {
  const primaryId = useAtomValue(primaryEnvironmentIdAtom);
  const primarySettings = useAtomValue(primaryServerSettingsAtom);
  const outbound = primarySettings.exowattCrossEnvironmentAgentTools;
  const inbound = primarySettings.exowattPeerInbound !== "off";
  const catalog = useAtomValue(candidatesAtom);
  const candidatesKey = peerLinkCandidatesKey(catalog);

  const wasOutbound = useRef(false);
  const wasInbound = useRef(false);
  const latest = useRef<ReconcileInput | null>(null);
  const primaryLabel =
    catalog.candidates.find((candidate) => candidate.environmentId === primaryId)?.label ??
    "P3 Code";
  // Runs before the reconcile effect below, so a queued reconcile always reads current inputs.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the reconciler's inputs current without restarting it.
  useEffect(() => {
    latest.current =
      primaryId && catalog.isReady
        ? {
            primaryId,
            catalog,
            peerLabel: exowattPeerSessionLabel({ label: primaryLabel, environmentId: primaryId }),
            primaryLabel,
          }
        : null;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Sync the primary's peer links with live desktop connections and periodic expiry.
  useEffect(() => {
    const input = latest.current;
    if (!input) return;
    const others = input.catalog.candidates.filter(
      (candidate) => candidate.environmentId !== input.primaryId && canLinkNow(candidate),
    );
    // Outbound off: the primary drops its links; retire its sessions on each B too.
    if (!outbound && wasOutbound.current) {
      for (const candidate of others) {
        void revokePeerSessions(candidate.environmentId, input.primaryId);
      }
    }
    // Inbound off: the primary revokes every reverse session itself; drop B's links to it.
    if (!inbound && wasInbound.current) {
      for (const candidate of others) {
        void removeRemotePeer(candidate.environmentId, input.primaryId);
        void revokePrimaryPeerSessions(candidate.environmentId);
      }
    }
    wasOutbound.current = outbound;
    wasInbound.current = inbound;
    if (!outbound && !inbound) return;
    const read = () => latest.current;
    requestReconcile(read);
    const interval = setInterval(() => requestReconcile(read), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run only when link-relevant state changes; inputs are read from `latest`.
  }, [outbound, inbound, primaryId, primaryLabel, candidatesKey]);
  return null;
}
