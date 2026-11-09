import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ExowattSidebarThreadSortMode } from "@t3tools/contracts/settings";
import { createElement, type ReactNode } from "react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import type { ExowattSidebarRowNesting } from "./ExowattSidebarChildThreads";
import {
  EXOWATT_SIDEBAR_FILTER_RESET_PATCH,
  ExowattSidebarThreadViewControl,
} from "./ExowattSidebarThreadViewControl";
import {
  filterExowattOlderSettledScopes,
  filterExowattSidebarThreads,
  isExowattSidebarFilterActive,
  type ExowattSidebarFilterState,
} from "./exowattSidebarFilter";
import {
  buildExowattSidebarNesting,
  summarizeExowattSidebarChildren,
  type ExowattSidebarChildSummary,
} from "./exowattSidebarNesting";
import {
  resolveExowattSidebarActivityMs,
  sortExowattSidebarThreads,
} from "./exowattSidebarThreadSort";
import { buildExowattSidebarProvenance } from "./exowattSidebarProvenance";
import type { ExowattSidebarOrigin } from "./exowattSidebarProvenance";
import { useExowattSidebarSubagentDisclosure } from "./useExowattSidebarSubagentDisclosure";

const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export interface ExowattSidebarView {
  readonly sortMode: ExowattSidebarThreadSortMode;
  /** True while the Active list follows a computed order (anything but Manual). */
  readonly activeTimeOrdered: boolean;
  /** Applies the filters to the top-level threads before shelf classification. */
  readonly filterThreads: (
    threads: readonly EnvironmentThreadShell[],
    nowMs: number,
  ) => EnvironmentThreadShell[];
  /** Orders the Active section in the chosen mode. */
  readonly sortActive: (threads: readonly EnvironmentThreadShell[]) => EnvironmentThreadShell[];
  /** Nested-subagent props for a parent row, undefined for rows without children. */
  readonly rowNestingByKey: ReadonlyMap<string, ExowattSidebarRowNesting>;
  /** Origins of visible rows and flattened grandchildren. */
  readonly originByKey: ReadonlyMap<string, ExowattSidebarOrigin>;
  /** Any filter is away from its default (the empty state says so). */
  readonly filterActive: boolean;
  /** Narrows upstream's older-settled paging to the environments the filters can show. */
  readonly filterOlderSettledScopes: <T extends { readonly environmentId: string }>(
    scopes: readonly T[],
  ) => readonly T[];
  /** The header control. */
  readonly control: ReactNode;
}

/**
 * Everything P3 layers onto upstream's v2 sidebar list, in one hook so
 * `Sidebar.tsx` only wires call sites: the sliders control (sort + filters),
 * the Active sort, and subagent nesting under parent rows.
 */
export function useExowattSidebarView(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly routeThreadKey: string | null;
  readonly primaryEnvironmentId: string | null;
}): ExowattSidebarView {
  const { threads, routeThreadKey, primaryEnvironmentId } = input;
  const sortMode = useClientSettings((s) => s["exowatt.sidebarSort"]);
  const sortReversed = useClientSettings((s) => s["exowatt.sidebarSortReversed"]);
  const nestExpandedByDefault = useClientSettings((s) => s["exowatt.sidebarNestDispatched"]);
  const filterWindow = useClientSettings((s) => s["exowatt.sidebarFilterWindow"]);
  const thisDeviceOnly = useClientSettings((s) => s["exowatt.sidebarFilterThisDevice"]);
  const needsMeOnly = useClientSettings((s) => s["exowatt.sidebarFilterNeedsMe"]);
  const hideSettled = useClientSettings((s) => s["exowatt.sidebarFilterHideSettled"]);
  const filter: ExowattSidebarFilterState = {
    window: filterWindow,
    thisDeviceOnly,
    needsMeOnly,
    hideSettled,
  };
  const filterActive = isExowattSidebarFilterActive(filter);

  const nesting = buildExowattSidebarNesting(threads, keyOf);
  const originByKey = buildExowattSidebarProvenance(threads, nesting, keyOf);
  const summaryByParentKey = new Map<string, ExowattSidebarChildSummary>();
  for (const [parentKey, children] of nesting.childrenByParentKey) {
    summaryByParentKey.set(parentKey, summarizeExowattSidebarChildren(children));
  }
  // A parent sorts and filters by its latest activity including its children.
  const activityMsOf = (thread: EnvironmentThreadShell) => {
    const own = resolveExowattSidebarActivityMs(thread);
    const children = summaryByParentKey.get(keyOf(thread))?.latestActivityMs;
    return children === undefined ? own : Math.max(own, children);
  };
  // The open thread is never hidden; an open subagent keeps its parent.
  const routeTopLevelKey =
    routeThreadKey === null
      ? null
      : (nesting.parentKeyByChildKey.get(routeThreadKey) ?? routeThreadKey);
  // Only an active filter needs the route, so navigation alone does not
  // invalidate the sidebar partition.
  const filterRouteKey = filterActive ? routeTopLevelKey : null;

  const filterThreads = (list: readonly EnvironmentThreadShell[], nowMs: number) => [
    ...filterExowattSidebarThreads(list, {
      filter,
      nowMs,
      primaryEnvironmentId,
      isCurrentThread: (thread) => keyOf(thread) === filterRouteKey,
      activityMsOf,
      descendantNeedsUser: (thread) => (summaryByParentKey.get(keyOf(thread))?.needsUser ?? 0) > 0,
    }),
  ];
  const sortActive = (list: readonly EnvironmentThreadShell[]) =>
    sortExowattSidebarThreads(list, { mode: sortMode, reversed: sortReversed, activityMsOf });
  const filterOlderSettledScopes = <T extends { readonly environmentId: string }>(
    scopes: readonly T[],
  ) => filterExowattOlderSettledScopes(scopes, { filter, primaryEnvironmentId });

  const disclosure = useExowattSidebarSubagentDisclosure();
  const rowNestingByKey = new Map<string, ExowattSidebarRowNesting>();
  for (const [parentKey, children] of nesting.childrenByParentKey) {
    const activeChildKey =
      routeThreadKey !== null && nesting.parentKeyByChildKey.get(routeThreadKey) === parentKey
        ? routeThreadKey
        : null;
    // Until the user toggles this parent, an open child shows its siblings.
    const expanded = disclosure.isExpanded(
      parentKey,
      activeChildKey !== null || nestExpandedByDefault,
    );
    rowNestingByKey.set(parentKey, {
      children,
      originByKey,
      summary: summaryByParentKey.get(parentKey)!,
      expanded,
      activeChildKey,
      onToggle: () => disclosure.setExpanded(parentKey, !expanded),
    });
  }

  const control = createElement(ExowattSidebarThreadViewControl, {
    mode: sortMode,
    onModeChange: (mode) => void updateClientSettings({ "exowatt.sidebarSort": mode }),
    reversed: sortReversed,
    onReversedChange: (reversed) =>
      void updateClientSettings({ "exowatt.sidebarSortReversed": reversed }),
    filter,
    onFilterChange: (patch) =>
      void updateClientSettings({
        ...(patch.window === undefined ? {} : { "exowatt.sidebarFilterWindow": patch.window }),
        ...(patch.thisDeviceOnly === undefined
          ? {}
          : { "exowatt.sidebarFilterThisDevice": patch.thisDeviceOnly }),
        ...(patch.needsMeOnly === undefined
          ? {}
          : { "exowatt.sidebarFilterNeedsMe": patch.needsMeOnly }),
        ...(patch.hideSettled === undefined
          ? {}
          : { "exowatt.sidebarFilterHideSettled": patch.hideSettled }),
      }),
    onReset: () => void updateClientSettings(EXOWATT_SIDEBAR_FILTER_RESET_PATCH),
  });

  return {
    sortMode,
    activeTimeOrdered: sortMode !== "manual",
    filterThreads,
    sortActive,
    rowNestingByKey,
    originByKey,
    filterActive,
    filterOlderSettledScopes,
    control,
  };
}
