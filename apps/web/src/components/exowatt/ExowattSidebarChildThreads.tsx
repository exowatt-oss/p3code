import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { exowattSidebarThreadNeedsUser } from "./exowattSidebarFilter";
import type { ExowattSidebarChildSummary } from "./exowattSidebarNesting";
import { ExowattSidebarRelationshipChip } from "./ExowattSidebarRelationshipChip";
import { ExowattThreadIcon, type ExowattThreadIconStatus } from "./ExowattThreadIcon";
import type { ExowattSidebarOrigin } from "./exowattSidebarProvenance";

/** Everything a parent row needs to render its nested subagents. */
export interface ExowattSidebarRowNesting {
  readonly children: readonly SidebarThreadSummary[];
  readonly originByKey: ReadonlyMap<string, ExowattSidebarOrigin>;
  readonly summary: ExowattSidebarChildSummary;
  readonly expanded: boolean;
  /** Key of the open child thread, so it keeps the route highlight. */
  readonly activeChildKey: string | null;
  readonly onToggle: () => void;
}

// Nested controls own their pointer and key events: they must never start a
// drag, select, rename, or open the parent row.
function stopRowEvent(event: ReactPointerEvent | ReactMouseEvent | ReactKeyboardEvent) {
  event.stopPropagation();
}

/** "+N" chip on a parent row; carries the children's rolled-up status. */
export function ExowattSidebarChildChip(props: { readonly nesting: ExowattSidebarRowNesting }) {
  const { summary, expanded, onToggle } = props.nesting;
  if (summary.count === 0) return null;
  const noun = summary.count === 1 ? "subagent" : "subagents";
  const statusText =
    summary.needsUser > 0
      ? `, ${summary.needsUser} need${summary.needsUser === 1 ? "s" : ""} you`
      : summary.running > 0
        ? `, ${summary.running} running`
        : "";
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} ${summary.count} ${noun}${statusText}`}
      data-testid="exowatt-sidebar-subagent-chip"
      onPointerDown={stopRowEvent}
      onDoubleClick={stopRowEvent}
      onKeyDown={stopRowEvent}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "inline-flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-2xs font-medium tabular-nums outline-none transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        summary.needsUser > 0
          ? "text-warning-foreground"
          : summary.running > 0
            ? "text-info-foreground"
            : "text-secondary-label",
      )}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
      />
      {summary.needsUser > 0 ? (
        <ShieldQuestionIcon aria-hidden className="size-3 shrink-0" />
      ) : summary.running > 0 ? (
        <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
      ) : (
        <BotIcon aria-hidden className="size-3 shrink-0" />
      )}
      <span>+{summary.count}</span>
    </button>
  );
}

function childStatus(thread: SidebarThreadSummary): {
  readonly label: string;
  readonly className: string;
  readonly icon: typeof CircleDashedIcon | null;
} | null {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") {
    return { label: "Approval", className: "text-warning-foreground", icon: ShieldQuestionIcon };
  }
  if (status === "input") {
    return {
      label: "Input",
      className: "text-indigo-600 dark:text-indigo-300",
      icon: MessageCircleQuestionIcon,
    };
  }
  if (exowattSidebarThreadNeedsUser(thread)) {
    return { label: "Plan ready", className: "text-warning-foreground", icon: null };
  }
  if (status === "working") {
    return { label: "Working", className: "text-info-foreground", icon: CircleDashedIcon };
  }
  if (status === "failed" || status === "limited") {
    return {
      label: status === "limited" ? "Limited" : "Failed",
      className: status === "limited" ? "text-warning-foreground" : "text-error-foreground",
      icon: CircleAlertIcon,
    };
  }
  return null;
}

/** The status light on a child's icon: same hues as its status label. */
function childIconStatus(thread: SidebarThreadSummary): ExowattThreadIconStatus {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return status;
  if (exowattSidebarThreadNeedsUser(thread)) return "plan";
  if (status === "working" || status === "failed" || status === "limited") return status;
  return thread.latestRun?.status === "completed" ? "done" : "idle";
}

function childTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp =
    thread.latestRun?.completedAt ?? thread.latestUserMessageAt ?? thread.latestRun?.requestedAt;
  if (timestamp == null) return "";
  const label = formatRelativeTimeLabel(timestamp);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** The expanded children under a parent row, one level deep. */
export function ExowattSidebarChildList(props: {
  readonly nesting: ExowattSidebarRowNesting;
  readonly onOpenChild: (threadRef: ScopedThreadRef) => void;
}) {
  const { onOpenChild } = props;
  const { children, expanded, activeChildKey } = props.nesting;
  if (!expanded || children.length === 0) return null;
  return (
    <ul
      role="presentation"
      data-testid="exowatt-sidebar-subagent-list"
      className="mb-0.5 ml-4 flex flex-col gap-px border-l border-sidebar-border pl-1"
    >
      {children.map((child) => {
        const threadRef = scopeThreadRef(child.environmentId, child.id);
        const key = scopedThreadKey(threadRef);
        const status = childStatus(child);
        const StatusIcon = status?.icon ?? null;
        const isActive = key === activeChildKey;
        const delegated = child.source.creationSource === "mcp";
        const kindLabel = delegated ? "Delegated task" : "Subagent";
        return (
          <li key={key} className="list-none">
            <div
              role="button"
              tabIndex={0}
              aria-label={`${kindLabel}: ${child.title}${status ? `, ${status.label}` : ""}`}
              aria-current={isActive ? "page" : undefined}
              data-testid="exowatt-sidebar-subagent-row"
              onPointerDown={stopRowEvent}
              onDoubleClick={stopRowEvent}
              onClick={(event) => {
                event.stopPropagation();
                onOpenChild(threadRef);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpenChild(threadRef);
              }}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
            >
              <ExowattThreadIcon
                environmentId={child.environmentId}
                threadId={child.id}
                title={child.title}
                status={childIconStatus(child)}
                className="text-icon-muted"
              />
              <span className="min-w-0 flex-1 truncate">{child.title}</span>
              <ExowattSidebarRelationshipChip
                origin={props.nesting.originByKey.get(key)}
                onNavigate={onOpenChild}
              />
              {status ? (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 font-medium",
                    status.className,
                  )}
                >
                  {StatusIcon ? <StatusIcon aria-hidden className="size-3 shrink-0" /> : null}
                  <span role="status">{status.label}</span>
                </span>
              ) : (
                <span className="shrink-0 tabular-nums text-secondary-label">
                  {childTimeLabel(child)}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
