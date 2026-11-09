import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { exowattSidebarThreadNeedsUser } from "./exowattSidebarFilter";
import { resolveExowattSidebarActivityMs } from "./exowattSidebarThreadSort";

/**
 * P3 nests subagent threads (`relationshipToParent === "subagent"`) under their top-level
 * ancestor so the parent row shows "+N" and rolls up their status. A child whose ancestor is
 * missing never becomes a top-level row; it stays hidden, as upstream hides every subagent.
 */
export type ExowattSidebarNestingThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "lineage" | "archivedAt"
>;

export function isExowattSidebarChildThread(
  thread: Pick<SidebarThreadSummary, "lineage">,
): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

function nestingKey(environmentId: string, threadId: string): string {
  return `${environmentId}\u0000${threadId}`;
}

export interface ExowattSidebarNesting<T> {
  /** Non-archived children per top-level ancestor key, newest activity first. */
  readonly childrenByParentKey: ReadonlyMap<string, readonly T[]>;
  /** Top-level ancestor key for every nested child. */
  readonly parentKeyByChildKey: ReadonlyMap<string, string>;
}

/**
 * Groups every subagent under its nearest non-subagent ancestor (one visual
 * level deep, grandchildren included). Keys come from `keyOf` so callers can
 * use the sidebar's scoped thread keys.
 */
export function buildExowattSidebarNesting<
  T extends ExowattSidebarNestingThread & Parameters<typeof resolveExowattSidebarActivityMs>[0],
>(threads: readonly T[], keyOf: (thread: T) => string): ExowattSidebarNesting<T> {
  const byId = new Map<string, T>();
  for (const thread of threads) byId.set(nestingKey(thread.environmentId, thread.id), thread);

  const resolveTopLevel = (thread: T): T | null => {
    let current: T = thread;
    const seen = new Set<T>();
    while (isExowattSidebarChildThread(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      const parentId = current.lineage.parentThreadId ?? current.lineage.rootThreadId;
      const parent =
        byId.get(nestingKey(current.environmentId, parentId)) ??
        byId.get(nestingKey(current.environmentId, current.lineage.rootThreadId));
      if (parent === undefined || parent === current) return null;
      current = parent;
    }
    return current === thread ? null : current;
  };

  const children = new Map<string, T[]>();
  const parentKeyByChildKey = new Map<string, string>();
  for (const thread of threads) {
    if (!isExowattSidebarChildThread(thread) || thread.archivedAt !== null) continue;
    const topLevel = resolveTopLevel(thread);
    if (topLevel === null) continue;
    const parentKey = keyOf(topLevel);
    parentKeyByChildKey.set(keyOf(thread), parentKey);
    const list = children.get(parentKey);
    if (list === undefined) children.set(parentKey, [thread]);
    else list.push(thread);
  }

  const childrenByParentKey = new Map<string, readonly T[]>();
  for (const [parentKey, list] of children) {
    childrenByParentKey.set(
      parentKey,
      list.length < 2
        ? list
        : list
            .map((thread) => ({ thread, activity: resolveExowattSidebarActivityMs(thread) }))
            .sort(
              (left, right) =>
                (Number.isFinite(right.activity) ? right.activity : Number.NEGATIVE_INFINITY) -
                  (Number.isFinite(left.activity) ? left.activity : Number.NEGATIVE_INFINITY) ||
                left.thread.id.localeCompare(right.thread.id),
            )
            .map(({ thread }) => thread),
    );
  }
  return { childrenByParentKey, parentKeyByChildKey };
}

export interface ExowattSidebarChildSummary {
  readonly count: number;
  readonly running: number;
  readonly needsUser: number;
  /** Latest activity across the children, -Infinity when none parses. */
  readonly latestActivityMs: number;
}

type SummaryThread = Parameters<typeof exowattSidebarThreadNeedsUser>[0] &
  Parameters<typeof resolveExowattSidebarActivityMs>[0];

/** Rolls the children up for the parent's "+N" chip, filters and sort. */
export function summarizeExowattSidebarChildren(
  children: readonly SummaryThread[],
): ExowattSidebarChildSummary {
  let running = 0;
  let needsUser = 0;
  let latestActivityMs = Number.NEGATIVE_INFINITY;
  for (const child of children) {
    if (exowattSidebarThreadNeedsUser(child)) needsUser += 1;
    else if (resolveSidebarThreadStatus(child) === "working") running += 1;
    const activity = resolveExowattSidebarActivityMs(child);
    if (Number.isFinite(activity) && activity > latestActivityMs) latestActivityMs = activity;
  }
  return { count: children.length, running, needsUser, latestActivityMs };
}

/** An expanded child list highlights the open child, so its parent row does not highlight too. */
export function exowattShowsActiveChild(
  nesting: { readonly expanded: boolean; readonly activeChildKey: string | null } | undefined,
): boolean {
  return nesting !== undefined && nesting.expanded && nesting.activeChildKey !== null;
}
