import type { ExowattSidebarThreadSortMode } from "@t3tools/contracts/settings";
import type { ComponentType } from "react";
import {
  ArrowDownAZIcon,
  CalendarDaysIcon,
  CircleDotIcon,
  Clock3Icon,
  GripVerticalIcon,
} from "lucide-react";

import type { SidebarThreadSummary } from "../../types";
import {
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  sortThreadsForSidebar,
} from "../Sidebar.logic";

/**
 * P3 thread sort for the v2 sidebar's Active section. Upstream sorts active
 * threads by `activeOrderKey` and keyless ones by `createdAt`, so a reopened
 * old thread and a brand-new one land at opposite ends of the list. P3 sorts by
 * last activity by default; "manual" keeps upstream's drag order.
 */
export const EXOWATT_SIDEBAR_THREAD_SORT_OPTIONS: readonly {
  readonly value: ExowattSidebarThreadSortMode;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}[] = [
  { value: "activity", label: "Last activity", icon: Clock3Icon },
  { value: "created_at", label: "Created", icon: CalendarDaysIcon },
  { value: "name", label: "Name", icon: ArrowDownAZIcon },
  { value: "status", label: "Status", icon: CircleDotIcon },
  { value: "manual", label: "Manual (drag to arrange)", icon: GripVerticalIcon },
];

/** How each computed mode reads in its normal and reversed direction. */
export const EXOWATT_SIDEBAR_THREAD_SORT_DIRECTION_LABELS: Record<
  Exclude<ExowattSidebarThreadSortMode, "manual">,
  { readonly normal: string; readonly reversed: string }
> = {
  activity: { normal: "Newest first", reversed: "Oldest first" },
  created_at: { normal: "Newest first", reversed: "Oldest first" },
  name: { normal: "A to Z", reversed: "Z to A" },
  status: { normal: "Running first", reversed: "Idle first" },
};

export type ExowattSidebarActivityThread = Pick<
  SidebarThreadSummary,
  "createdAt" | "updatedAt" | "latestUserMessageAt" | "latestRun" | "unsettledAt"
>;

function timestampMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Last activity: latest user message, run request/start/completion, un-settle, or creation
 * (-Infinity when nothing parses). `updatedAt` counts only without those: v2 bumps it for
 * bookkeeping (order keys, pins, auto-settle), so a drag or a pin would reshuffle the list.
 */
export function resolveExowattSidebarActivityMs(thread: ExowattSidebarActivityThread): number {
  let signal: number | null = null;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
    thread.unsettledAt,
  ]) {
    const parsed = timestampMs(candidate);
    if (parsed !== null && (signal === null || parsed > signal)) signal = parsed;
  }
  const created = timestampMs(thread.createdAt);
  const fallback = signal ?? timestampMs(thread.updatedAt);
  const latest = Math.max(
    fallback ?? Number.NEGATIVE_INFINITY,
    created ?? Number.NEGATIVE_INFINITY,
  );
  return latest;
}

export type ExowattSidebarThreadStatusGroup = "running" | "needs-attention" | "idle";

export type ExowattSidebarStatusThread = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "pendingBackgroundTasks"
>;

/** Coarse status buckets for the Status sort, read from the row's own status. */
export function resolveExowattSidebarThreadStatusGroup(
  thread: ExowattSidebarStatusThread,
): ExowattSidebarThreadStatusGroup {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "working" || status === "waiting") return "running";
  if (
    status === "approval" ||
    status === "input" ||
    status === "failed" ||
    status === "limited" ||
    resolveThreadStatusPill({ thread })?.label === "Plan Ready"
  ) {
    return "needs-attention";
  }
  return "idle";
}

const STATUS_RANK: Record<ExowattSidebarThreadStatusGroup, number> = {
  running: 0,
  "needs-attention": 1,
  idle: 2,
};

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export type ExowattSidebarSortableThread = ExowattSidebarActivityThread &
  ExowattSidebarStatusThread & {
    readonly id: string;
    readonly title: string;
    readonly pinnedAt: string | null;
    readonly activeOrderKey: string | null;
  };

export interface ExowattSidebarThreadSortOptions<T> {
  readonly mode: ExowattSidebarThreadSortMode;
  /** Flips the mode's direction; malformed timestamps still sink. Manual ignores it. */
  readonly reversed?: boolean | undefined;
  /** Overrides the activity anchor, e.g. a parent rolled up with its subagents. */
  readonly activityMsOf?: ((thread: T) => number) | undefined;
}

function sinkNonFinite(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * Sorts a list in the chosen mode. Pinned threads stay first in their given
 * order (the pinned block owns its own arrangement); "manual" defers to
 * upstream's active-order-key sort. Ties fall back to name, then id.
 */
export function sortExowattSidebarThreads<T extends ExowattSidebarSortableThread>(
  threads: readonly T[],
  options: ExowattSidebarThreadSortOptions<T>,
): T[] {
  if (options.mode === "manual") return sortThreadsForSidebar(threads);
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const thread of threads) (thread.pinnedAt == null ? unpinned : pinned).push(thread);
  const activityOf = options.activityMsOf ?? resolveExowattSidebarActivityMs;
  const keyed = unpinned.map((thread) => ({
    thread,
    activity: sinkNonFinite(activityOf(thread)),
    created: timestampMs(thread.createdAt) ?? Number.NEGATIVE_INFINITY,
    status:
      options.mode === "status" ? STATUS_RANK[resolveExowattSidebarThreadStatusGroup(thread)] : 0,
  }));
  const direction = options.reversed ? -1 : 1;
  const byDescending = (left: number, right: number) => {
    if (left === right) return 0;
    if (left === Number.NEGATIVE_INFINITY) return 1;
    if (right === Number.NEGATIVE_INFINITY) return -1;
    return (right > left ? 1 : -1) * direction;
  };
  keyed.sort((left, right) => {
    let comparison = 0;
    switch (options.mode) {
      case "activity":
        comparison = byDescending(left.activity, right.activity);
        break;
      case "created_at":
        comparison = byDescending(left.created, right.created);
        break;
      case "name":
        comparison = NAME_COLLATOR.compare(left.thread.title, right.thread.title) * direction;
        break;
      case "status":
        comparison =
          (left.status - right.status) * direction || byDescending(left.activity, right.activity);
        break;
    }
    return (
      comparison ||
      NAME_COLLATOR.compare(left.thread.title, right.thread.title) ||
      left.thread.id.localeCompare(right.thread.id)
    );
  });
  return [...pinned, ...keyed.map(({ thread }) => thread)];
}
