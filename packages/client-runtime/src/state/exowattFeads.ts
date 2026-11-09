import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Exowatt feads integration: the status stream plus the three settings
 * commands. Commands run serially per environment so a Save followed by a Test
 * cannot race the token write.
 */
export function createExowattFeadsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };

  return {
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:exowatt:feads-status",
      tag: WS_METHODS.exowattFeadsStatus,
      // Settings and /agents both read it; keep the stream warm between pages.
      idleTtlMs: 60_000,
    }),
    // Feed snapshots for the /agents panels. Closed as soon as nobody looks so an
    // idle server keeps only the poller, not three dangling streams per client.
    agentwatch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:exowatt:feads-agentwatch",
      tag: WS_METHODS.exowattFeadsAgentwatch,
      idleTtlMs: 0,
    }),
    myIssues: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:exowatt:feads-my-issues",
      tag: WS_METHODS.exowattFeadsMyIssues,
      idleTtlMs: 0,
    }),
    inbox: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:exowatt:feads-inbox",
      tag: WS_METHODS.exowattFeadsInbox,
      idleTtlMs: 0,
    }),
    ackNotifications: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:feads-ack-notifications",
      tag: WS_METHODS.exowattFeadsAckNotifications,
      scheduler,
      concurrency,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:feads-configure",
      tag: WS_METHODS.exowattFeadsConfigure,
      scheduler,
      concurrency,
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:feads-clear",
      tag: WS_METHODS.exowattFeadsClear,
      scheduler,
      concurrency,
    }),
    test: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:feads-test",
      tag: WS_METHODS.exowattFeadsTest,
      scheduler,
      concurrency,
    }),
  };
}
