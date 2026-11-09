import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";

type ContextWindowCost = NonNullable<ContextWindowSnapshot["cost"]>;

/** exowatt: the meter snapshot plus the cost of the latest priced turn, when the turn before it was priced too. */
export type ContextWindowSnapshotWithCost = ContextWindowSnapshot & {
  readonly lastTurnCost?: ContextWindowCost | null;
};

/**
 * exowatt: overlays the provider-reported session cost (Pi/Phi `costUsd`) on the meter's
 * snapshot. It rides on persisted provider turns, so it survives reload; mid-turn live reports
 * carry no cost and keep the last one. Only the latest provider session's total is shown.
 */
export function withProviderTurnCost(
  snapshot: ContextWindowSnapshot | null,
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "ordinal" | "tokenUsage">
  >,
): ContextWindowSnapshotWithCost | null {
  if (snapshot === null) return null;
  let latest:
    | {
        readonly turn: (typeof providerTurns)[number];
        readonly usage: OrchestrationV2ProviderTurnTokenUsage;
      }
    | undefined;
  for (const turn of providerTurns) {
    const usage = turn.tokenUsage;
    if (usage?.costUsd === undefined) continue;
    if (latest === undefined || usage.updatedAt >= latest.usage.updatedAt) latest = { turn, usage };
  }
  const totalUsd = latest?.usage.costUsd;
  // A zero total usually means the model has no price table entry, not a free session.
  if (latest === undefined || totalUsd === undefined || totalUsd === 0) return snapshot;
  const { providerThreadId, ordinal } = latest.turn;
  const previousUsd =
    ordinal === 1
      ? 0
      : providerTurns.find(
          (turn) => turn.providerThreadId === providerThreadId && turn.ordinal === ordinal - 1,
        )?.tokenUsage?.costUsd;
  const lastTurnUsd = previousUsd === undefined ? null : totalUsd - previousUsd;
  return {
    ...snapshot,
    cost: { amount: totalUsd, currency: "USD" },
    lastTurnCost:
      lastTurnUsd === null || lastTurnUsd < 0 ? null : { amount: lastTurnUsd, currency: "USD" },
  };
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
