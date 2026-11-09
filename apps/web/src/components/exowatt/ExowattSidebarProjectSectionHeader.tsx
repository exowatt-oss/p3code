import { GripVerticalIcon } from "lucide-react";

import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Collapsible header for one project section of the grouped default sidebar, built on
 * upstream's shelf header (emphasized above the muted Snoozed / Settled shelves) so the
 * stream reads as one hierarchy: project, then pinned, active, snoozed, settled.
 */
export function ExowattSidebarProjectSectionHeader({
  projectKey,
  title,
  threadCount,
  collapsed,
  onToggle,
  onMove,
}: {
  readonly projectKey: string;
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly onToggle: (projectKey: string) => void;
  /** Available for real projects while grouped manual sorting is selected. */
  readonly onMove?: ((sourceKey: string, targetKey: string) => void) | undefined;
}) {
  return (
    <li
      data-thread-selection-safe
      className="list-none"
      data-exowatt-sidebar-project-section=""
      onDragOver={
        onMove
          ? (event) => {
              if (event.dataTransfer.types.includes("application/x-p3-project-section"))
                event.preventDefault();
            }
          : undefined
      }
      onDrop={
        onMove
          ? (event) => {
              const sourceKey = event.dataTransfer.getData("application/x-p3-project-section");
              if (sourceKey && sourceKey !== projectKey) {
                event.preventDefault();
                onMove(sourceKey, projectKey);
              }
            }
          : undefined
      }
    >
      <div className="mt-2 mb-0.5 flex items-center">
        {onMove ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-p3-project-section", projectKey);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  aria-label={`Drag ${title} to reorder projects`}
                  className="flex h-8 cursor-grab items-center pl-1 text-sidebar-muted-foreground"
                />
              }
            >
              <GripVerticalIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Drag to reorder projects</TooltipPopup>
          </Tooltip>
        ) : null}
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            onClick={() => onToggle(projectKey)}
            expanded={!collapsed}
            tone="emphasized"
            data-testid="exowatt-sidebar-project-section-toggle"
            accessory={<span className="font-normal tabular-nums">{threadCount}</span>}
          >
            {/* The header keeps its label from shrinking, so a long project name truncates here. */}
            <span className="block max-w-40 truncate">{title}</span>
          </CollapsibleSectionHeader>
        </div>
      </div>
    </li>
  );
}
