/**
 * Exowatt: a thread's Font Awesome icon with its status light.
 *
 * The icon comes from the environment's icon feed (picked by the server once
 * the thread has a title); until it arrives, or for a name this build cannot
 * draw, the title's keyword pick stands in so a row never renders empty.
 */
import {
  type EnvironmentId,
  type ExowattThreadIconName,
  fallbackExowattThreadIcon,
  isExowattThreadIconName,
  type ThreadId,
} from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { exowattThreadIconsEnvironment } from "../../state/exowattThreadIcons";
import { useEnvironmentQuery } from "../../state/query";
import { EXOWATT_THREAD_ICON_GLYPHS } from "./exowattThreadIconGlyphs";

/** The icon to draw for a thread: the stored pick, else the title's keyword pick. */
export function useExowattThreadIconName(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: string,
): ExowattThreadIconName {
  const query = useEnvironmentQuery(
    exowattThreadIconsEnvironment.icons({ environmentId, input: {} }),
  );
  const stored = query.data?.get(threadId)?.icon;
  return stored !== undefined && isExowattThreadIconName(stored)
    ? stored
    : fallbackExowattThreadIcon(title);
}

export function ExowattFontAwesomeGlyph(props: {
  readonly icon: ExowattThreadIconName;
  readonly className?: string;
}) {
  const [width, height, , , path] = EXOWATT_THREAD_ICON_GLYPHS[props.icon].icon;
  return (
    <svg
      aria-hidden
      focusable="false"
      data-icon={props.icon}
      viewBox={`0 0 ${width} ${height}`}
      // Font Awesome 7 glyphs may reach past their box (an antenna, a flame tip).
      overflow="visible"
      className={cn("shrink-0", props.className)}
    >
      {/* Free-solid glyphs are one path; duotone ones would be two. */}
      <path fill="currentColor" d={typeof path === "string" ? path : path.join(" ")} />
    </svg>
  );
}

export type ExowattThreadIconStatus =
  | "approval"
  | "input"
  | "plan"
  | "working"
  | "failed"
  | "limited"
  | "done"
  | "idle";

// The sidebar status pill's dot palette (Sidebar.logic.ts); a plan waiting on you is amber like
// every other needs-you state in P3's rows.
const STATUS_DOTS: Record<ExowattThreadIconStatus, { className: string; label: string }> = {
  approval: { className: "bg-amber-500 dark:bg-amber-300/90", label: "Needs approval" },
  input: { className: "bg-indigo-500 dark:bg-indigo-300/90", label: "Needs input" },
  plan: { className: "bg-amber-500 dark:bg-amber-300/90", label: "Plan ready" },
  working: {
    className: "bg-sky-500 motion-safe:animate-status-pulse dark:bg-sky-300/80",
    label: "Working",
  },
  failed: { className: "bg-red-500 dark:bg-red-300/90", label: "Failed" },
  limited: { className: "bg-amber-500 dark:bg-amber-300/90", label: "Usage limited" },
  done: { className: "bg-emerald-500 dark:bg-emerald-300/90", label: "Done" },
  idle: { className: "bg-muted-foreground/45", label: "Idle" },
};

/** The thread's icon with a small status-colored dot on its lower right. */
export function ExowattThreadIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: ExowattThreadIconStatus;
  readonly className?: string;
}) {
  const icon = useExowattThreadIconName(props.environmentId, props.threadId, props.title);
  const dot = STATUS_DOTS[props.status];
  return (
    <span
      data-testid="exowatt-thread-icon"
      data-thread-icon={icon}
      data-thread-status={props.status}
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center",
        props.className,
      )}
    >
      <ExowattFontAwesomeGlyph icon={icon} className="size-3.5" />
      <span
        role="img"
        aria-label={dot.label}
        data-status-light={props.status === "working" ? "running" : undefined}
        className={cn(
          "absolute -right-0.5 -bottom-0.5 block size-1.5 rounded-full ring-1 ring-sidebar",
          dot.className,
        )}
      />
    </span>
  );
}
