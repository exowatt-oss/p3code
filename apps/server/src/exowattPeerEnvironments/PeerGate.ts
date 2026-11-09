// Exowatt distro: the receiver-side peer gate, shared by `PeerInbound` and the orchestrator's
// queue drain. Kept free of service imports so orchestration can use it without a cycle.
import { type ExowattPeerInbound, MessageId, type RuntimeMode } from "@t3tools/contracts";

import { lowerRuntimeMode } from "../orchestration-v2/DispatchModeLimit.ts";

// A *reverse* (receiver-gated) peer message carries this id prefix: the run records it as
// `userMessageId`, durably, so the gate can find and cancel its queued runs. A forward peer
// message (ungated: see `isExowattReversePeerSessionLabel`) uses a normal MessageId and is
// invisible to this prefix, exactly like any other local message.
const PEER_MESSAGE_ID_PREFIX = "message:p3-peer:";

export const makePeerMessageId = (uuid: string) =>
  MessageId.make(`${PEER_MESSAGE_ID_PREFIX}${uuid}`);

export const isPeerMessageId = (messageId: string) => messageId.startsWith(PEER_MESSAGE_ID_PREFIX);

/** Whether a thread at `runtimeMode` may run peer work under `inbound`. */
export const peerInboundAllows = (inbound: ExowattPeerInbound, runtimeMode: RuntimeMode) =>
  inbound !== "off" && lowerRuntimeMode(runtimeMode, inbound) === runtimeMode;
