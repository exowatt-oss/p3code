import type { ExowattSidebarProjectSort } from "@t3tools/contracts/settings";

export const EXOWATT_SIDEBAR_PROJECT_SORT_OPTIONS: readonly {
  readonly value: ExowattSidebarProjectSort;
  readonly label: string;
}[] = [
  { value: "activity", label: "Recent activity" },
  { value: "created_at", label: "Date created" },
  { value: "name", label: "Name" },
  { value: "manual", label: "Manual (drag sections)" },
];
