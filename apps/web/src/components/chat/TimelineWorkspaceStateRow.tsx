import { exowattFeadsIssueUrl } from "@t3tools/contracts";
import { SquareArrowOutUpRightIcon } from "lucide-react";
import { useExowattFeadsStatus } from "../../hooks/useExowattFeads";
import { memo, use } from "react";
import ChatMarkdown from "../ChatMarkdown";
import { cn } from "~/lib/utils";
import { type WorkspaceState } from "../../session-logic";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";

const END_STATE_PRESENTATION: Record<
  WorkspaceState["endState"],
  { readonly label: string; readonly className: string }
> = {
  complete: { label: "Complete", className: "text-success-foreground" },
  "awaiting-human": { label: "Awaiting you", className: "text-warning-foreground" },
  "mid-work": { label: "Mid-work", className: "text-info-foreground" },
  "blocked-approval": { label: "Blocked on approval", className: "text-warning-foreground" },
};

/** How the turn ended, as a dot and a label in its status colour. */
export function WorkspaceEndStateLabel({
  endState,
  className,
}: {
  endState: WorkspaceState["endState"];
  className?: string;
}) {
  const presentation = END_STATE_PRESENTATION[endState];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-medium",
        presentation.className,
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {presentation.label}
    </span>
  );
}

function FeadsEpicLink({ epic }: { epic: string }) {
  const { status } = useExowattFeadsStatus();
  if (!status?.configured) return null;
  return (
    <a
      className="inline-flex items-center gap-1.5 text-xs text-secondary-label hover:text-foreground"
      href={`http://127.0.0.1:3000/#/issues?issue=${encodeURIComponent(epic)}`}
      target="_blank"
      rel="noreferrer"
    >
      <SquareArrowOutUpRightIcon aria-hidden className="size-3" />
      <span className="font-mono">{epic}</span>
    </a>
  );
}

export const WorkspaceStateTimelineRow = memo(function WorkspaceStateTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "workspace-state" }>;
}) {
  const { markdownCwd } = use(TimelineRowCtx);
  const { workspaceState } = row;
  const question = row.showQuestion ? workspaceState.question : null;
  // Nothing beyond the reply above: one quiet status line instead of a card.
  if (question === null && workspaceState.openItems.length === 0) {
    return (
      <div className="mx-auto my-2 flex w-full max-w-3xl items-center gap-3 px-1 text-xs">
        <WorkspaceEndStateLabel endState={workspaceState.endState} />
        {workspaceState.feadsEpic ? <FeadsEpicLink epic={workspaceState.feadsEpic} /> : null}
      </div>
    );
  }
  return (
    <section className="mx-auto my-3 w-full max-w-3xl rounded-2xl border border-border/80 bg-card/70 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-medium text-foreground">Session state</h3>
        <WorkspaceEndStateLabel className="text-xs" endState={workspaceState.endState} />
      </div>
      {question ? (
        <p className="mt-2 text-foreground">
          <ChatMarkdown inline text={question} cwd={markdownCwd} parseRawHtml={false} />
        </p>
      ) : null}
      {workspaceState.openItems.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          {workspaceState.openItems.map((item) => (
            <li key={item}>
              <ChatMarkdown inline text={item} cwd={markdownCwd} parseRawHtml={false} />
            </li>
          ))}
        </ul>
      ) : null}
      {workspaceState.feadsEpic ? (
        <div className="mt-2.5">
          <FeadsEpicLink epic={workspaceState.feadsEpic} />
        </div>
      ) : null}
    </section>
  );
});
