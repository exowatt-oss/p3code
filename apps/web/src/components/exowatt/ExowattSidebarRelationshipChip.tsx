import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ExowattSidebarOrigin } from "./exowattSidebarProvenance";

/** A bounded, keyboard-accessible link to a thread's v2 lineage origin. */
export function ExowattSidebarRelationshipChip(props: {
  readonly origin: ExowattSidebarOrigin | undefined;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
}) {
  const { origin, onNavigate } = props;
  if (origin === undefined) return null;
  const label = origin.title ?? "another thread";
  const className =
    "inline-flex max-w-32 shrink-0 items-center gap-1 overflow-hidden rounded-sm px-1 text-2xs text-secondary-label outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  const content = (
    <>
      <span className="shrink-0">via</span>
      <span className="truncate">{label}</span>
    </>
  );
  // A missing shell still has a lineage id, but there is no confirmed thread
  // to navigate to (e.g. its parent has been deleted or is on another server).
  if (origin.title === null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className={className} aria-label={`via ${label}`} />}>
          {content}
        </TooltipTrigger>
        <TooltipPopup side="top">via {origin.id}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            data-exowatt-relationship-chip=""
            href={`/${encodeURIComponent(origin.environmentId)}/${encodeURIComponent(origin.id)}`}
            aria-label={`Open origin thread: ${label}`}
            className={className}
            onPointerDown={(event: PointerEvent) => event.stopPropagation()}
            onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
            onDoubleClick={(event: MouseEvent) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onNavigate(scopeThreadRef(origin.environmentId, origin.id));
            }}
          />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup side="top">via {label}</TooltipPopup>
    </Tooltip>
  );
}
