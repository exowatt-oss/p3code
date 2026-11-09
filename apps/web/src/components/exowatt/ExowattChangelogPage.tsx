import { memo } from "react";

import { APP_VERSION, IS_DEV_BUILD } from "../../branding";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  EXOWATT_CHANGELOG,
  formatExowattChangelogDate,
  resolveExowattChangelogView,
  type ExowattChangelogEntryView,
} from "./exowattChangelog";

/**
 * What's new: one scrollable column, newest release on top. The running
 * build's entry is highlighted so "what did I just get?" is answered at a
 * glance; everything below it is history.
 */
export function ExowattChangelogPage() {
  const entries = resolveExowattChangelogView(EXOWATT_CHANGELOG, APP_VERSION, IS_DEV_BUILD);
  const releasedCount = entries.filter((entry) => !entry.unreleased).length;

  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="What's new breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem current>
          <h1>What's new</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <span className="ms-auto truncate text-xs text-muted-foreground tabular-nums">
        {releasedCount} {releasedCount === 1 ? "release" : "releases"}
      </span>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <div
          className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain"
          data-exowatt-changelog-scroll
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 pb-16 pt-4 sm:px-6">
            <p className="text-sm text-muted-foreground">
              Every P3 Code release and what it changed for you. Updates arrive through the Exowatt
              Homebrew tap (<code className="font-mono text-xs">brew upgrade --cask p3-code</code>).
            </p>
            <ol className="mt-3 flex flex-col" aria-label="Releases">
              {entries.map((entry) => (
                <ChangelogEntry key={entry.release.version} entry={entry} />
              ))}
            </ol>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

const ChangelogEntry = memo(function ChangelogEntry({
  entry,
}: {
  readonly entry: ExowattChangelogEntryView;
}) {
  const { release } = entry;
  const date = formatExowattChangelogDate(release.date);
  return (
    <li
      className={cn(
        "relative grid gap-x-6 gap-y-1 border-s border-border/60 ps-6 pb-8 sm:grid-cols-[9.5rem_minmax(0,1fr)]",
        entry.current && "border-primary/60",
      )}
      data-exowatt-changelog-entry={entry.versionLabel}
      aria-current={entry.current ? "true" : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "absolute -start-[5px] top-1.5 size-2.5 rounded-full border-2 border-background",
          entry.current ? "bg-primary" : entry.unreleased ? "bg-muted-foreground/40" : "bg-border",
        )}
      />
      <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:pt-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "font-mono text-sm tabular-nums",
              entry.current ? "font-semibold text-foreground" : "text-foreground/85",
            )}
          >
            {entry.buildLabel}
          </span>
          {entry.current ? (
            <Badge variant="default" size="sm">
              Installed
            </Badge>
          ) : null}
          {entry.unreleased ? (
            <Badge variant="outline" size="sm">
              Unreleased
            </Badge>
          ) : null}
        </div>
        {date ? <time dateTime={release.date}>{date}</time> : null}
        <span className="font-mono text-2xs tabular-nums opacity-80">
          T3 Code {release.upstream}
        </span>
        {entry.upstreamBump ? <span className="text-2xs opacity-80">New upstream base</span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {release.title ? (
          <h2 className="text-base font-semibold leading-tight">{release.title}</h2>
        ) : null}
        <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-foreground/90">
          {release.items.map((item) => (
            <li key={item} className="flex gap-2">
              <span
                aria-hidden
                className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
              />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
});
