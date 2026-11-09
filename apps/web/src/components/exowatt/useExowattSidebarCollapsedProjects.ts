import { Schema } from "effect";

import { useLocalStorage } from "../../hooks/useLocalStorage";

const COLLAPSED_PROJECTS_KEY = "t3code:sidebar-v2:exowatt-collapsed-projects";
const EMPTY: readonly string[] = [];
const COLLAPSED_PROJECTS_SCHEMA = Schema.Array(Schema.String);

/**
 * Which project sections of the grouped default sidebar are folded. Device
 * local like upstream's shelf toggles: it is a viewing preference, not data.
 */
export function useExowattSidebarCollapsedProjects(): {
  readonly collapsedProjectKeys: ReadonlySet<string>;
  readonly toggleProjectCollapsed: (projectKey: string) => void;
} {
  const [collapsed, setCollapsed] = useLocalStorage(
    COLLAPSED_PROJECTS_KEY,
    EMPTY,
    COLLAPSED_PROJECTS_SCHEMA,
  );
  const collapsedProjectKeys = new Set(collapsed);
  const toggleProjectCollapsed = (projectKey: string) =>
    setCollapsed((current) =>
      current.includes(projectKey)
        ? current.filter((key) => key !== projectKey)
        : [...current, projectKey],
    );
  return { collapsedProjectKeys, toggleProjectCollapsed };
}
