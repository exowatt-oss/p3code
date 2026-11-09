import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { useClientSettings } from "../../hooks/useSettings";
import {
  orderExowattSidebarSectionProjects,
  partitionExowattSidebarSections,
  type ExowattSidebarShelves,
} from "./exowattSidebarSections";
import { useExowattSidebarCollapsedProjects } from "./useExowattSidebarCollapsedProjects";

/** View-only project sections over v2's already filtered and sorted shelves. */
export function useExowattSidebarProjects(input: {
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly orderedProjects: readonly Project[];
  readonly threads: readonly EnvironmentThreadShell[];
  /** `exowatt.sidebarGroupByProject`, off while upstream's boring-sidebar folders are on. */
  readonly grouped: boolean;
  readonly shelves: ExowattSidebarShelves<EnvironmentThreadShell>;
}) {
  const { grouped } = input;
  const projectSort = useClientSettings((s) => s["exowatt.sidebarProjectSort"]);
  const { collapsedProjectKeys, toggleProjectCollapsed } = useExowattSidebarCollapsedProjects();
  const manualRanks = new Map(
    input.orderedProjects.map(
      (project, index) => [`${project.environmentId}:${project.id}`, index] as const,
    ),
  );
  const sections = partitionExowattSidebarSections(input.shelves, {
    groupByProject: grouped,
    projects: grouped
      ? orderExowattSidebarSectionProjects(input.projects, input.threads, projectSort, manualRanks)
      : input.projects,
    collapsedProjectKeys,
  });
  return { grouped, sections, toggleProjectCollapsed };
}
