import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

/**
 * Shelf toggles stay global, but each project shows only its own shelf count.
 * Mirrors upstream's `SidebarSectionHeader` (muted tone, trailing count).
 */
export function ExowattSidebarProjectShelfHeader(props: {
  readonly shelf: "snoozed" | "settled";
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li data-thread-selection-safe data-exowatt-project-shelf className="mx-0.5 mt-2 list-none">
      <CollapsibleSectionHeader
        onClick={props.onToggle}
        expanded={props.expanded}
        tone="muted"
        data-testid={`sidebar-${props.shelf}-shelf-toggle`}
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        {props.shelf === "snoozed" ? "Snoozed" : "Settled"}
      </CollapsibleSectionHeader>
    </li>
  );
}
