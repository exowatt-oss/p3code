import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createExowattHarnessConfigEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };

  return {
    mcpInventory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:exowatt:harness-mcp-list",
      tag: WS_METHODS.exowattHarnessMcpList,
    }),
    addMcpServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:harness-mcp-add",
      tag: WS_METHODS.exowattHarnessMcpAdd,
      scheduler,
      concurrency,
    }),
    toggleMcpServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:harness-mcp-toggle",
      tag: WS_METHODS.exowattHarnessMcpToggle,
      scheduler,
      concurrency,
    }),
    mcpStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:exowatt:harness-mcp-status",
      tag: WS_METHODS.exowattHarnessMcpStatus,
    }),
    connectMcpServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:harness-mcp-connect",
      tag: WS_METHODS.exowattHarnessMcpConnect,
      scheduler,
      concurrency,
    }),
    assetInventory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:exowatt:harness-asset-list",
      tag: WS_METHODS.exowattHarnessAssetList,
    }),
    toggleAsset: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:exowatt:harness-asset-toggle",
      tag: WS_METHODS.exowattHarnessAssetToggle,
      scheduler,
      concurrency,
    }),
  };
}
