import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Exowatt thread Hub overlay: one live subscription per open thread plus upsert/delete commands.
 * The server re-pushes the thread's entries after every change from any client, so commands need
 * no optimistic state. Writes run serially per thread so a quick pin-then-hide lands in order.
 */
export function createExowattThreadHubEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly threadId: string };
    }) => `${environmentId}:${input.threadId}`,
  };

  return {
    entries: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:exowatt:thread-hub",
      tag: WS_METHODS.exowattThreadHubSubscribe,
      // Switching threads and back should not flash an empty overlay.
      idleTtlMs: 30_000,
    }),
    upsert: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:thread-hub-upsert",
      tag: WS_METHODS.exowattThreadHubUpsert,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:thread-hub-delete",
      tag: WS_METHODS.exowattThreadHubDelete,
      scheduler,
      concurrency,
    }),
  };
}
