import type { ExowattSidebarDensity } from "@t3tools/contracts/settings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import type { SidebarThreadSummary } from "../../types";
import type { SidebarSection } from "../Sidebar.logic";

/** Comfortable keeps v2's active/working cards and parked slim rows. */
export function resolveExowattSidebarRowVariant(
  section: SidebarSection,
  density: ExowattSidebarDensity,
): "card" | "slim" {
  if (density === "compact") return "slim";
  return section === "pinned" || section === "active" || section === "working" ? "card" : "slim";
}

/** Project headers (or a single-project scope) already identify their rows. */
export function resolveExowattSidebarRowProjectPrefix(input: {
  readonly density: ExowattSidebarDensity;
  readonly grouped: boolean;
  readonly scopedToOneProject: boolean;
  readonly projectTitle: string | null;
}): string | null {
  if (
    input.density !== "compact" ||
    input.grouped ||
    input.scopedToOneProject ||
    input.projectTitle === null
  )
    return null;
  const segments = input.projectTitle.split(" · ");
  return segments[segments.length - 1]?.trim() || input.projectTitle;
}

/** Include legacy single-link PRs when the v2 link list is empty. */
export function exowattCompactPullRequestCount(
  thread: Pick<SidebarThreadSummary, "pullRequests">,
  fallbackPrCount = 0,
): number {
  return visibleThreadPullRequests(thread.pullRequests).length || fallbackPrCount;
}
