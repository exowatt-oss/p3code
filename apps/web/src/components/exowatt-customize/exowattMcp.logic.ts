import type {
  ExowattHarnessId,
  ExowattHarnessItemStatus,
  ExowattMcpRuntimeStatus,
} from "@t3tools/contracts";

export function resolveMcpEnablementControl(input: {
  readonly harness: ExowattHarnessId;
  readonly rawStatus: ExowattHarnessItemStatus;
  readonly runtimeStatus: ExowattMcpRuntimeStatus | undefined;
  readonly runtimeSupportsEnablement: boolean;
}): { readonly enabled: boolean | undefined; readonly canToggle: boolean } {
  if (input.harness !== "phi") {
    return { enabled: input.rawStatus === "enabled", canToggle: true };
  }
  return {
    enabled: input.runtimeStatus?.enabled,
    canToggle: input.runtimeSupportsEnablement && input.runtimeStatus !== undefined,
  };
}

/** Return state only when it belongs to the currently selected environment. */
export function environmentScopedValue<T>(
  currentEnvironmentId: string | null,
  state: { readonly environmentId: string | null; readonly value: T },
  empty: T,
): T {
  return state.environmentId === currentEnvironmentId ? state.value : empty;
}
