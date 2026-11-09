/**
 * Exowatt: Phi's context-aware compaction is off for embedders, so P3 sessions compacted mid-run at
 * ~227k tokens even on 1M models. Default `PI_CONTEXT_BUDGET=on` and a 500k soft ceiling; a value the
 * user set wins (`PI_CONTEXT_BUDGET=off` opts out) and Phi still prefers per-model/settings ceilings.
 */

/** Phi's switch for the context-aware compaction ladder. */
export const PI_CONTEXT_BUDGET_ENV = "PI_CONTEXT_BUDGET";
/** P3's default for the ladder: on (a user value still wins). */
export const P3_PHI_CONTEXT_BUDGET_DEFAULT = "on";
/** Phi's host default for `compaction.softCeilingTokens`. */
export const PI_COMPACTION_SOFT_CEILING_ENV = "PI_COMPACTION_SOFT_CEILING_TOKENS";
/** P3's default soft ceiling: half of a 1M window, where Opus and Fable stay sharp. */
export const P3_PHI_SOFT_CEILING_TOKENS = 500_000;

const isSet = (value: string | undefined): boolean => (value?.trim() ?? "") !== "";

/** Builds the compaction overlay for a Phi spawn; never overrides a value the user set. */
export function phiCompactionEnvironment(input: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): NodeJS.ProcessEnv {
  const { environment } = input;
  const overlay: NodeJS.ProcessEnv = {};
  if (!isSet(environment[PI_CONTEXT_BUDGET_ENV])) {
    overlay[PI_CONTEXT_BUDGET_ENV] = P3_PHI_CONTEXT_BUDGET_DEFAULT;
  }
  if (!isSet(environment[PI_COMPACTION_SOFT_CEILING_ENV])) {
    overlay[PI_COMPACTION_SOFT_CEILING_ENV] = String(P3_PHI_SOFT_CEILING_TOKENS);
  }
  return overlay;
}
