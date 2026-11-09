import type { SidebarThreadSummary } from "../../types";
import type { ExowattSidebarNesting } from "./exowattSidebarNesting";

export interface ExowattSidebarOrigin {
  readonly environmentId: SidebarThreadSummary["environmentId"];
  readonly id: SidebarThreadSummary["id"];
  readonly title: string | null;
}

/**
 * Resolve the v2 lineage already carried by the sidebar shells. The nesting
 * map is visual (grandchildren are flattened); lineage is the actual creator.
 * A child directly underneath its creator needs no redundant "via" label.
 */
export function buildExowattSidebarProvenance<
  T extends Pick<SidebarThreadSummary, "environmentId" | "id" | "title" | "lineage" | "forkedFrom">,
>(
  threads: readonly T[],
  nesting: Pick<ExowattSidebarNesting<T>, "parentKeyByChildKey">,
  keyOf: (thread: T) => string,
): ReadonlyMap<string, ExowattSidebarOrigin> {
  const byId = new Map<string, T>();
  for (const thread of threads) byId.set(`${thread.environmentId}\u0000${thread.id}`, thread);

  const origins = new Map<string, ExowattSidebarOrigin>();
  for (const thread of threads) {
    const { lineage } = thread;
    if (lineage.relationshipToParent === null) continue;
    const originId =
      lineage.relationshipToParent === "fork" && thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : lineage.parentThreadId;
    if (originId === null || originId === thread.id) continue;
    const origin = byId.get(`${thread.environmentId}\u0000${originId}`);
    const key = keyOf(thread);
    // The +N disclosure and its child row already place a direct child under
    // its parent. A flattened grandchild still benefits from its direct origin.
    if (origin !== undefined && nesting.parentKeyByChildKey.get(key) === keyOf(origin)) continue;
    origins.set(key, {
      environmentId: thread.environmentId,
      id: originId,
      title: origin?.title ?? null,
    });
  }
  return origins;
}
