import type { ExowattSidebarProjectSort } from "@t3tools/contracts/settings";

import type { ThreadSortInput } from "@t3tools/client-runtime/state/thread-sort";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";

/** Structural mirror of Sidebar.logic's (unexported) LogicalSidebarProject. */
export interface ExowattSidebarSectionProject {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjectRefs: readonly { environmentId: string; projectId: string }[];
}

interface SectionableThread {
  readonly environmentId: string;
  readonly projectId: string;
}

type SortableSectionThread = ThreadSortInput & SectionableThread & { archivedAt: string | null };

/**
 * The four upstream shelves the default sidebar renders, already partitioned
 * and sorted. Sectioning only ever filters these lists, so pinned / active /
 * snoozed / settled semantics (and their order) survive untouched inside
 * every project section.
 */
export interface ExowattSidebarShelves<T> {
  readonly pinned: readonly T[];
  readonly active: readonly T[];
  readonly snoozed: readonly T[];
  readonly settled: readonly T[];
  /** Snoozed rows currently rendered (the shelf may be collapsed to a header). */
  readonly visibleSnoozed: readonly T[];
  /** Settled rows currently rendered (the tail is paged). */
  readonly renderedSettled: readonly T[];
}

export interface ExowattSidebarSection<T> extends ExowattSidebarShelves<T> {
  /** Null for the single flat section (grouping off). */
  readonly projectKey: string | null;
  readonly title: string | null;
  readonly threadCount: number;
  readonly collapsed: boolean;
}

export const EXOWATT_SIDEBAR_OTHER_SECTION_KEY = "exowatt:other";

/**
 * Orders logical project groups for the sectioned stream. Upstream's own
 * project sort covers activity / created / manual; "name" is P3-only, and
 * manual reuses the user's drag order from the project list (rank of the
 * group's first member).
 */
export function orderExowattSidebarSectionProjects<
  TProject extends ExowattSidebarSectionProject,
  TThread extends SortableSectionThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sort: ExowattSidebarProjectSort,
  manualRankByPhysicalProjectKey: ReadonlyMap<string, number>,
): TProject[] {
  switch (sort) {
    case "activity":
      return sortLogicalProjectsForSidebar(projects, threads, "updated_at");
    case "created_at":
      return sortLogicalProjectsForSidebar(projects, threads, "created_at");
    case "name":
      return [...projects].toSorted(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.projectKey.localeCompare(right.projectKey),
      );
    case "manual": {
      const rank = (project: TProject) =>
        Math.min(
          ...project.memberProjectRefs.map(
            (ref) =>
              manualRankByPhysicalProjectKey.get(`${ref.environmentId}:${ref.projectId}`) ??
              Number.POSITIVE_INFINITY,
          ),
        );
      return [...projects].toSorted((left, right) => rank(left) - rank(right));
    }
  }
}

/**
 * One section per project, in project order; projects without a visible thread get none and
 * threads of unlisted projects fall into a trailing "Other" section so nothing disappears.
 * Grouping off returns one untitled section, so the renderer has a single code path.
 */
export function partitionExowattSidebarSections<T extends SectionableThread>(
  shelves: ExowattSidebarShelves<T>,
  options: {
    readonly groupByProject: boolean;
    readonly projects: readonly ExowattSidebarSectionProject[];
    readonly collapsedProjectKeys: ReadonlySet<string>;
  },
): ExowattSidebarSection<T>[] {
  const total =
    shelves.pinned.length + shelves.active.length + shelves.snoozed.length + shelves.settled.length;
  if (!options.groupByProject) {
    return [{ ...shelves, projectKey: null, title: null, threadCount: total, collapsed: false }];
  }
  const projectKeyByPhysical = new Map<string, string>();
  for (const project of options.projects) {
    for (const ref of project.memberProjectRefs) {
      projectKeyByPhysical.set(`${ref.environmentId}:${ref.projectId}`, project.projectKey);
    }
  }
  type MutableShelves = { -readonly [K in keyof ExowattSidebarShelves<T>]: T[] };
  const buckets = new Map<string, MutableShelves>();
  const shelf = (projectKey: string) => {
    let section = buckets.get(projectKey);
    if (!section) {
      section = {
        pinned: [],
        active: [],
        snoozed: [],
        settled: [],
        visibleSnoozed: [],
        renderedSettled: [],
      };
      buckets.set(projectKey, section);
    }
    return section;
  };
  // Bucket once per shelf, not once per project: streaming shell updates stay
  // linear even with a large project catalog.
  const add = <K extends keyof ExowattSidebarShelves<T>>(name: K, list: readonly T[]) => {
    for (const thread of list) {
      const projectKey =
        projectKeyByPhysical.get(`${thread.environmentId}:${thread.projectId}`) ??
        EXOWATT_SIDEBAR_OTHER_SECTION_KEY;
      shelf(projectKey)[name].push(thread);
    }
  };
  add("pinned", shelves.pinned);
  add("active", shelves.active);
  add("snoozed", shelves.snoozed);
  add("settled", shelves.settled);
  add("visibleSnoozed", shelves.visibleSnoozed);
  add("renderedSettled", shelves.renderedSettled);

  const sections: ExowattSidebarSection<T>[] = [];
  const pushSection = (projectKey: string, title: string) => {
    const section = buckets.get(projectKey);
    if (!section) return;
    const threadCount =
      section.pinned.length +
      section.active.length +
      section.snoozed.length +
      section.settled.length;
    if (threadCount === 0) return;
    sections.push({
      ...section,
      projectKey,
      title,
      threadCount,
      collapsed: options.collapsedProjectKeys.has(projectKey),
    });
  };
  for (const project of options.projects) {
    pushSection(project.projectKey, project.displayName);
  }
  pushSection(EXOWATT_SIDEBAR_OTHER_SECTION_KEY, "Other");
  return sections;
}
