import type {
  ExowattSidebarFilterWindow,
  ExowattSidebarProjectSort,
  ExowattSidebarThreadSortMode,
} from "@t3tools/contracts/settings";
import {
  ArchiveXIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BellRingIcon,
  Clock3Icon,
  MonitorSmartphoneIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  EXOWATT_SIDEBAR_FILTER_DEFAULTS,
  EXOWATT_SIDEBAR_FILTER_WINDOW_OPTIONS,
  countActiveExowattSidebarFilters,
  type ExowattSidebarFilterState,
} from "./exowattSidebarFilter";
import {
  EXOWATT_SIDEBAR_THREAD_SORT_DIRECTION_LABELS,
  EXOWATT_SIDEBAR_THREAD_SORT_OPTIONS,
} from "./exowattSidebarThreadSort";
import { EXOWATT_SIDEBAR_PROJECT_SORT_OPTIONS } from "./exowattSidebarProjectSort";

/**
 * P3's sliders control in the sidebar header row: how the Active list sorts
 * and which threads the activity / device / needs-me / settled filters keep.
 * A dot marks the trigger while any filter is away from its default. Project
 * scope stays upstream's own control beside it.
 */
export function ExowattSidebarThreadViewControl({
  mode,
  onModeChange,
  reversed,
  onReversedChange,
  filter,
  onFilterChange,
  onReset,
}: {
  readonly mode: ExowattSidebarThreadSortMode;
  readonly onModeChange: (mode: ExowattSidebarThreadSortMode) => void;
  readonly reversed: boolean;
  readonly onReversedChange: (reversed: boolean) => void;
  readonly filter: ExowattSidebarFilterState;
  readonly onFilterChange: (patch: Partial<ExowattSidebarFilterState>) => void;
  /** Puts every filter back to its default (sort is a preference, not a filter). */
  readonly onReset: () => void;
}) {
  const grouped = useClientSettings((s) => s["exowatt.sidebarGroupByProject"]);
  const projectSort = useClientSettings((s) => s["exowatt.sidebarProjectSort"]);
  const activeCount = countActiveExowattSidebarFilters(filter);
  const isActive = activeCount > 0;
  const label = isActive
    ? `Sort and filter threads (${activeCount} filter${activeCount === 1 ? "" : "s"} on)`
    : "Sort and filter threads";
  const directionLabels =
    mode === "manual" ? null : EXOWATT_SIDEBAR_THREAD_SORT_DIRECTION_LABELS[mode];
  const windowLabel =
    EXOWATT_SIDEBAR_FILTER_WINDOW_OPTIONS.find((option) => option.value === filter.window)
      ?.shortLabel ?? "All";

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={label}
            data-testid="exowatt-sidebar-view-trigger"
            data-filtered={isActive ? "" : undefined}
          />
        }
      >
        <SlidersHorizontalIcon className="size-4" />
        {isActive ? (
          <span
            aria-hidden="true"
            data-testid="exowatt-sidebar-filter-badge"
            className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Sort active threads</MenuGroupLabel>
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => onModeChange(value as ExowattSidebarThreadSortMode)}
          >
            {EXOWATT_SIDEBAR_THREAD_SORT_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  data-testid={`exowatt-sidebar-sort-${option.value}`}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <span>{option.label}</span>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
        {directionLabels ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Direction</MenuGroupLabel>
              <MenuRadioGroup
                value={reversed ? "reversed" : "normal"}
                onValueChange={(value) => onReversedChange(value === "reversed")}
              >
                <MenuRadioItem value="normal" data-testid="exowatt-sidebar-sort-direction-normal">
                  <span className="flex items-center gap-2">
                    <ArrowDownIcon className="size-4 text-muted-foreground" />
                    <span>{directionLabels.normal}</span>
                  </span>
                </MenuRadioItem>
                <MenuRadioItem
                  value="reversed"
                  data-testid="exowatt-sidebar-sort-direction-reversed"
                >
                  <span className="flex items-center gap-2">
                    <ArrowUpIcon className="size-4 text-muted-foreground" />
                    <span>{directionLabels.reversed}</span>
                  </span>
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
        {grouped ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Sort projects</MenuGroupLabel>
              <MenuRadioGroup
                value={projectSort}
                onValueChange={(value) =>
                  updateClientSettings({
                    "exowatt.sidebarProjectSort": value as ExowattSidebarProjectSort,
                  })
                }
              >
                {EXOWATT_SIDEBAR_PROJECT_SORT_OPTIONS.map((option) => (
                  <MenuRadioItem
                    key={option.value}
                    value={option.value}
                    data-testid={`exowatt-sidebar-project-sort-${option.value}`}
                  >
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Filter</MenuGroupLabel>
          <MenuSub>
            <MenuSubTrigger data-testid="exowatt-sidebar-filter-window">
              <Clock3Icon className="size-4" />
              <span className="min-w-0 flex-1 truncate">Active within</span>
              <span className="text-xs text-muted-foreground">{windowLabel}</span>
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-44">
              <MenuRadioGroup
                value={filter.window}
                onValueChange={(value) =>
                  onFilterChange({ window: value as ExowattSidebarFilterWindow })
                }
              >
                {EXOWATT_SIDEBAR_FILTER_WINDOW_OPTIONS.map((option) => (
                  <MenuRadioItem
                    key={option.value}
                    value={option.value}
                    data-testid={`exowatt-sidebar-filter-window-${option.value}`}
                  >
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuCheckboxItem
            checked={filter.thisDeviceOnly}
            onCheckedChange={(checked) => onFilterChange({ thisDeviceOnly: checked })}
            variant="switch"
            data-testid="exowatt-sidebar-filter-this-device"
          >
            <span className="flex items-center gap-2">
              <MonitorSmartphoneIcon className="size-4 text-muted-foreground" />
              <span>This device only</span>
            </span>
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={filter.needsMeOnly}
            onCheckedChange={(checked) => onFilterChange({ needsMeOnly: checked })}
            variant="switch"
            data-testid="exowatt-sidebar-filter-needs-me"
          >
            <span className="flex items-center gap-2">
              <BellRingIcon className="size-4 text-muted-foreground" />
              <span>Needs me only</span>
            </span>
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={filter.hideSettled}
            onCheckedChange={(checked) => onFilterChange({ hideSettled: checked })}
            variant="switch"
            data-testid="exowatt-sidebar-filter-hide-settled"
          >
            <span className="flex items-center gap-2">
              <ArchiveXIcon className="size-4 text-muted-foreground" />
              <span>Hide settled</span>
            </span>
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem disabled={!isActive} onClick={onReset} data-testid="exowatt-sidebar-filter-reset">
          <RotateCcwIcon className="size-4" />
          Reset filters
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Settings patch for "Reset filters". */
export const EXOWATT_SIDEBAR_FILTER_RESET_PATCH = {
  "exowatt.sidebarFilterWindow": EXOWATT_SIDEBAR_FILTER_DEFAULTS.window,
  "exowatt.sidebarFilterThisDevice": EXOWATT_SIDEBAR_FILTER_DEFAULTS.thisDeviceOnly,
  "exowatt.sidebarFilterNeedsMe": EXOWATT_SIDEBAR_FILTER_DEFAULTS.needsMeOnly,
  "exowatt.sidebarFilterHideSettled": EXOWATT_SIDEBAR_FILTER_DEFAULTS.hideSettled,
} as const;
