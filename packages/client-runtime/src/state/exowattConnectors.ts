import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Exowatt distro: commands behind the Customize › MCP connector catalog. The
 * catalog itself is static data in `@t3tools/contracts`; only the P3 bearer
 * token has to come from the server.
 */
export function createExowattConnectorsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();

  return {
    issueAgentToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:connectors-issue-agent-token",
      tag: WS_METHODS.exowattConnectorsIssueAgentToken,
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
      },
    }),
    // "Reconnect now": the same reconciliation the server runs at startup, so
    // it is serial per environment like the mint above.
    reconcile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:connectors-reconcile",
      tag: WS_METHODS.exowattConnectorsReconcile,
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
      },
    }),
  };
}
