/**
 * Row and section chrome shared by every Hub section: a flat section with an icon tile, title,
 * count badge and one quiet trailing action; descriptions live in the title's tooltip. Sections
 * are split by dividers, tiles stay neutral, and colour is kept for counts and what needs you.
 */
import { ChevronDownIcon, ChevronRightIcon, CornerUpLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Ellipsis at the *start* of the text, so the filename tail of a long path
 * stays readable. RTL flips which end overflows; the LRM bookends keep the
 * separators of an LTR path in their written order inside that RTL box.
 */
export function HubPathText({
  value,
  className,
}: {
  value: string;
  className?: string | undefined;
}) {
  return <span className={cn("truncate text-left [direction:rtl]", className)}>{`‎${value}‎`}</span>;
}

export type HubTone = "neutral" | "warning" | "danger";

const TILE_TONE: Record<HubTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  warning: "bg-warning/14 text-warning-foreground",
  danger: "bg-destructive/12 text-destructive-foreground",
};

/** Rounded square that holds an icon, so every row and card has a visual anchor. */
export function HubIconTile({
  tone = "neutral",
  size = "row",
  className,
  children,
}: {
  tone?: HubTone;
  size?: "section" | "row";
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        size === "section"
          ? "size-7 rounded-lg [&_svg]:size-4"
          : "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        TILE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function HubCountBadge({
  value,
  tone = "neutral",
  label,
}: {
  value: number | string;
  tone?: "primary" | "neutral";
  label?: string | undefined;
}) {
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1.5 text-3xs font-medium tabular-nums",
        tone === "primary" ? "bg-primary/14 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

/**
 * One Hub section. `description` is what lives here in plain words, shown as the
 * title's tooltip. `open`/`onToggle` turn the title into a disclosure for
 * sections that fold (Connectors); a folded section is just its header row.
 */
export function HubSection({
  title,
  icon,
  tone = "neutral",
  description,
  count,
  countTone = "neutral",
  countLabel,
  action,
  open,
  onToggle,
  className,
  children,
}: {
  title: string;
  icon: ReactNode;
  tone?: HubTone;
  description?: string | undefined;
  count?: number | undefined;
  countTone?: "primary" | "neutral";
  countLabel?: string | undefined;
  action?: ReactNode;
  open?: boolean | undefined;
  onToggle?: (() => void) | undefined;
  className?: string | undefined;
  children?: ReactNode;
}) {
  const collapsible = onToggle !== undefined;
  const heading = (
    <>
      <HubIconTile size="section" tone={tone}>
        {icon}
      </HubIconTile>
      <span className="truncate text-sm font-semibold text-foreground">{title}</span>
      {count === undefined ? null : (
        <HubCountBadge label={countLabel} tone={countTone} value={count} />
      )}
      {collapsible ? (
        open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        )
      ) : null}
    </>
  );
  const headingClass = "flex min-w-0 items-center gap-2.5 text-left";
  const trigger = collapsible ? (
    <button
      aria-expanded={open}
      className={cn(
        headingClass,
        "rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
      onClick={onToggle}
      type="button"
    >
      {heading}
    </button>
  ) : (
    <span className={cn(headingClass, "cursor-default")}>{heading}</span>
  );
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <section
      aria-label={title}
      className={cn("py-3 first:pt-1 not-first:border-t not-first:border-border/60", className)}
    >
      <div className="flex h-8 items-center gap-2 pr-0.5 pl-1">
        {description ? (
          <Tooltip>
            <TooltipTrigger render={trigger} />
            <TooltipPopup className="max-w-64" side="left">
              {description}
            </TooltipPopup>
          </Tooltip>
        ) : (
          trigger
        )}
        <span className="flex-1" />
        {action}
      </div>
      {hasBody ? <div className="mt-1.5 flex flex-col gap-0.5">{children}</div> : null}
    </section>
  );
}

export function HubGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground/80 first:pt-0.5">
      {children}
    </div>
  );
}

/** "+3 more", "12 files read": a quiet full-width disclosure inside a card. */
export function HubDisclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-expanded={open}
      className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-2xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      onClick={onToggle}
      type="button"
    >
      {open ? (
        <ChevronDownIcon className="size-3.5 shrink-0" />
      ) : (
        <ChevronRightIcon className="size-3.5 shrink-0" />
      )}
      {children}
    </button>
  );
}

/**
 * One artifact. The whole row is the primary action; the trailing controls are
 * separate buttons so a click on them never also triggers the row.
 */
export function HubRow({
  icon,
  label,
  detail,
  count,
  onActivate,
  onJump,
  actions,
  title,
  labelIsPath = false,
  detailIsPath = false,
  dimmed = false,
}: {
  icon: ReactNode;
  label: string;
  detail?: string | null | undefined;
  count?: number | undefined;
  onActivate?: (() => void) | undefined;
  onJump?: (() => void) | undefined;
  actions?: ReactNode;
  title?: string | undefined;
  /** Truncate the label from the left, for paths. */
  labelIsPath?: boolean;
  detailIsPath?: boolean;
  /** A row the user hid, listed behind "Show N hidden". */
  dimmed?: boolean;
}) {
  return (
    <div
      className={cn(
        "group flex h-9 items-center gap-2 rounded-lg px-1",
        onActivate ? "hover:bg-accent/70" : null,
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default",
                dimmed ? "opacity-55" : null,
              )}
              disabled={!onActivate}
              onClick={onActivate}
            >
              <HubIconTile>{icon}</HubIconTile>
              {labelIsPath ? (
                <HubPathText className="min-w-0 flex-1 text-xs text-foreground" value={label} />
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{label}</span>
              )}
              {detail ? (
                detailIsPath ? (
                  <HubPathText
                    className="max-w-[40%] shrink-0 font-mono text-3xs text-muted-foreground/60 group-hover:hidden"
                    value={detail}
                  />
                ) : (
                  <span className="max-w-[40%] shrink-0 truncate text-2xs text-muted-foreground/60 group-hover:hidden">
                    {detail}
                  </span>
                )
              ) : null}
            </button>
          }
        />
        <TooltipPopup side="left">{title ?? label}</TooltipPopup>
      </Tooltip>
      {count !== undefined && count > 1 ? (
        <span className="shrink-0 text-3xs tabular-nums text-muted-foreground/60 group-hover:hidden">
          ×{count}
        </span>
      ) : null}
      <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
        {onJump ? (
          <HubIconAction label="Jump to source" onClick={onJump}>
            <CornerUpLeftIcon className="size-3.5" />
          </HubIconAction>
        ) : null}
        {actions}
      </span>
    </div>
  );
}

export function HubIconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button aria-label={label} onClick={onClick} size="icon-xs" variant="ghost-muted">
            {children}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
