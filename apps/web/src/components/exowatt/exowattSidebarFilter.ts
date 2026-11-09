import type { ExowattSidebarFilterWindow } from "@t3tools/contracts/settings";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "../Sidebar.logic";
import {
  resolveExowattSidebarActivityMs,
  type ExowattSidebarActivityThread,
  type ExowattSidebarStatusThread,
} from "./exowattSidebarThreadSort";

/**
 * P3 sidebar filters (the sliders control in the sidebar header), ported to
 * v2's `EnvironmentThreadShell`. Pure: the component and `Sidebar.tsx` only
 * read these helpers, so every boundary is unit-testable.
 */
export interface ExowattSidebarFilterState {
  /** Activity window a thread must fall inside to stay visible. */
  readonly window: ExowattSidebarFilterWindow;
  /** Only threads on this client's own (primary) environment. */
  readonly thisDeviceOnly: boolean;
  /** Only threads waiting on the user. */
  readonly needsMeOnly: boolean;
  /** Drop the Settled shelf entirely. */
  readonly hideSettled: boolean;
}

export const EXOWATT_SIDEBAR_FILTER_DEFAULTS: ExowattSidebarFilterState = {
  window: "all",
  thisDeviceOnly: false,
  needsMeOnly: false,
  hideSettled: false,
};

const HOUR_MS = 60 * 60 * 1000;

const WINDOW_DURATION_MS: Record<ExowattSidebarFilterWindow, number | null> = {
  all: null,
  "24h": 24 * HOUR_MS,
  "48h": 48 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
};

export const EXOWATT_SIDEBAR_FILTER_WINDOW_OPTIONS: readonly {
  readonly value: ExowattSidebarFilterWindow;
  readonly label: string;
  readonly shortLabel: string;
}[] = [
  { value: "all", label: "All time", shortLabel: "All" },
  { value: "24h", label: "Last 24 hours", shortLabel: "24h" },
  { value: "48h", label: "Last 48 hours", shortLabel: "48h" },
  { value: "7d", label: "Last 7 days", shortLabel: "7d" },
];

/** Window length in ms, or null for "All time" (no time filtering). */
export function exowattSidebarFilterWindowMs(window: ExowattSidebarFilterWindow): number | null {
  return WINDOW_DURATION_MS[window] ?? null;
}

/** How many of the four filters are away from their default. */
export function countActiveExowattSidebarFilters(filter: ExowattSidebarFilterState): number {
  let count = 0;
  if (filter.window !== EXOWATT_SIDEBAR_FILTER_DEFAULTS.window) count += 1;
  if (filter.thisDeviceOnly) count += 1;
  if (filter.needsMeOnly) count += 1;
  if (filter.hideSettled) count += 1;
  return count;
}

export function isExowattSidebarFilterActive(filter: ExowattSidebarFilterState): boolean {
  return countActiveExowattSidebarFilters(filter) > 0;
}

/** Everything the filter needs from a sidebar thread row. */
export type ExowattSidebarFilterThread = ExowattSidebarActivityThread &
  ExowattSidebarStatusThread &
  Pick<SidebarThreadSummary, "environmentId" | "settledOverride">;

/** The row status pills that mean "waiting on you". */
const NEEDS_ME_STATUS_LABELS: ReadonlySet<string> = new Set([
  "Pending Approval",
  "Awaiting Input",
  "Plan Ready",
]);

/** Reuses the row status pill so "Needs me" can never drift from the badge. */
export function exowattSidebarThreadNeedsUser(thread: ExowattSidebarStatusThread): boolean {
  const pill = resolveThreadStatusPill({ thread });
  return pill !== null && NEEDS_ME_STATUS_LABELS.has(pill.label);
}

export interface ExowattSidebarFilterContext {
  readonly filter: ExowattSidebarFilterState;
  readonly nowMs: number;
  /** This client's own server. Null (not yet resolved) disables "This device only". */
  readonly primaryEnvironmentId: string | null;
}

export function threadPassesExowattSidebarFilter(
  input: ExowattSidebarFilterContext & {
    readonly thread: ExowattSidebarFilterThread;
    /** The thread currently open (or the parent of the open subagent): never hidden. */
    readonly isCurrentThread?: boolean;
    /** Activity anchor override, e.g. the parent rolled up with its subagents. */
    readonly activityMs?: number;
    /** A nested subagent of this thread is waiting on the user. */
    readonly descendantNeedsUser?: boolean;
  },
): boolean {
  if (input.isCurrentThread === true) return true;
  const { filter, thread } = input;
  if (
    filter.thisDeviceOnly &&
    input.primaryEnvironmentId !== null &&
    thread.environmentId !== input.primaryEnvironmentId
  ) {
    return false;
  }
  // Work waiting on the user is never hidden by the window or the settled
  // toggle: that is exactly what the filters exist to surface.
  const needsUser = exowattSidebarThreadNeedsUser(thread) || input.descendantNeedsUser === true;
  if (filter.needsMeOnly && !needsUser) return false;
  if (needsUser) return true;
  if (filter.hideSettled && thread.settledOverride === "settled") return false;
  const windowMs = exowattSidebarFilterWindowMs(filter.window);
  if (windowMs !== null) {
    // In-flight work is current by definition, however old its last stamp.
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working") return true;
    const activityMs = input.activityMs ?? resolveExowattSidebarActivityMs(thread);
    // A thread with no parseable timestamp cannot be shown to be inside the
    // window, so a narrowed window drops it.
    if (!Number.isFinite(activityMs) || activityMs < input.nowMs - windowMs) return false;
  }
  return true;
}

/**
 * Narrows upstream's older-settled paging scopes to rows the filters can show. Rows the server
 * holds back are settled and idle (live rows stay in the shell), so "Hide settled" and "Needs
 * me" can show none of them; "This device only" keeps the primary environment's scopes.
 */
export function filterExowattOlderSettledScopes<T extends { readonly environmentId: string }>(
  scopes: readonly T[],
  input: Pick<ExowattSidebarFilterContext, "filter" | "primaryEnvironmentId">,
): readonly T[] {
  const { filter, primaryEnvironmentId } = input;
  if (filter.hideSettled || filter.needsMeOnly) return [];
  if (filter.thisDeviceOnly && primaryEnvironmentId !== null) {
    return scopes.filter((scope) => scope.environmentId === primaryEnvironmentId);
  }
  return scopes;
}

export function filterExowattSidebarThreads<T extends ExowattSidebarFilterThread>(
  threads: readonly T[],
  input: ExowattSidebarFilterContext & {
    readonly isCurrentThread?: ((thread: T) => boolean) | undefined;
    readonly activityMsOf?: ((thread: T) => number) | undefined;
    readonly descendantNeedsUser?: ((thread: T) => boolean) | undefined;
  },
): readonly T[] {
  if (!isExowattSidebarFilterActive(input.filter)) return threads;
  return threads.filter((thread) =>
    threadPassesExowattSidebarFilter({
      thread,
      filter: input.filter,
      nowMs: input.nowMs,
      primaryEnvironmentId: input.primaryEnvironmentId,
      isCurrentThread: input.isCurrentThread?.(thread) ?? false,
      ...(input.activityMsOf ? { activityMs: input.activityMsOf(thread) } : {}),
      descendantNeedsUser: input.descendantNeedsUser?.(thread) ?? false,
    }),
  );
}
