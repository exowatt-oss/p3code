import {
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** How much a runtime mode allows, narrowest first. */
export function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

/** How much an interaction mode allows: plan, then default. */
export function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

/**
 * Whether a provider's advertised modes include "auto". An empty or undefined list is not a
 * restricted set, so "auto" counts as supported (as `providerRuntimeMode` in RuntimePolicy.ts).
 */
function targetSupportsAuto(targetSupportedModes: ReadonlyArray<RuntimeMode> | undefined): boolean {
  return (
    targetSupportedModes === undefined ||
    targetSupportedModes.length === 0 ||
    targetSupportedModes.includes("auto")
  );
}

/**
 * The mode a child runs at: the one asked for, never broader than its parent's.
 * An inherited mode the target provider does not offer steps down to the
 * broadest one it does; an explicitly requested one is refused instead.
 */
export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: {
    readonly modelSelection: ModelSelection;
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  },
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  let resolved = inherited ? parentMode : requested;
  // exowatt: Pi has no "auto" mode. Never refuse it or collapse it to "approval-required" (every
  // tool call would prompt); fall back to the parent's own mode, which cannot escalate, or to
  // "auto-accept-edits" when the parent itself runs "auto" on a provider that supports it.
  const autoFallback = resolved === "auto" && !targetSupportsAuto(target?.supportedRuntimeModes);
  if (autoFallback) {
    resolved = parentMode === "auto" ? "auto-accept-edits" : parentMode;
  }
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "runtime_mode_escalation_denied",
        message: `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      }),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited && !autoFallback) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      }),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

/** The same, for interaction modes. */
export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
      )
    : Effect.succeed(resolved);
}

/** The task as its child receives it, with the role the caller asked for. */
export function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}
