/**
 * Task stack for the Hub: a progress bar, what the agent is working on now,
 * what is next, and the finished steps folded behind one disclosure. Fed by
 * the thread's v2 `todo_list` plans (Claude TodoWrite, Codex update_plan,
 * Cursor todos, Phi todos); a provider that never emits one gets no section.
 */
import type { OrchestrationV2PlanArtifact, RunId } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDashedIcon, ListChecksIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { HubDisclosure, HubSection } from "./HubPrimitives";

const COLLAPSED_ROWS = 6;

export interface HubTask {
  readonly id: string;
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

type TodoPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

/** The latest run's todo list, else the thread's most recent one. */
function activeTodoPlan(
  plans: readonly OrchestrationV2PlanArtifact[],
  latestRunId: RunId | null,
): TodoPlan | null {
  const todos = plans.filter((plan): plan is TodoPlan => plan.kind === "todo_list");
  return (
    todos.findLast((plan) => latestRunId !== null && plan.runId === latestRunId) ??
    todos.at(-1) ??
    null
  );
}

/** When a completed step finished: its anchor plus its duration, if the server recorded both. */
function completedAtMs(step: TodoPlan["steps"][number]): number | null {
  if (step.durationAnchorAt === undefined || step.durationMs === undefined) return null;
  const anchor = Date.parse(step.durationAnchorAt);
  return Number.isNaN(anchor) ? null : anchor + step.durationMs;
}

/** In-progress first, then completed newest-first, then pending in plan order. */
export function hubTaskStack(
  plans: readonly OrchestrationV2PlanArtifact[],
  latestRunId: RunId | null,
): HubTask[] {
  const plan = activeTodoPlan(plans, latestRunId);
  if (!plan) return [];
  const rank = { running: 0, completed: 1, pending: 2 } as const;
  return plan.steps
    .map((step, index) => ({ step, index }))
    .toSorted((a, b) => {
      const byStatus = rank[a.step.status] - rank[b.step.status];
      if (byStatus !== 0) return byStatus;
      if (a.step.status === "completed") {
        const left = completedAtMs(a.step);
        const right = completedAtMs(b.step);
        // Without timing, later in the plan is assumed to have finished later.
        if (left !== null && right !== null && left !== right) return right - left;
        return b.index - a.index;
      }
      return a.index - b.index;
    })
    .map(({ step }) => ({
      id: step.id,
      step: step.text,
      status: step.status === "running" ? "inProgress" : step.status,
    }));
}

function TaskRow({ task }: { task: HubTask }) {
  if (task.status === "inProgress") {
    return (
      <div className="flex min-h-9 items-start gap-2.5 rounded-lg bg-accent px-2 py-2 text-xs">
        <LoaderCircleIcon className="mt-px size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <span className="line-clamp-2 min-w-0 flex-1 font-medium text-foreground">{task.step}</span>
      </div>
    );
  }
  const completed = task.status === "completed";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex h-8 items-center gap-2.5 px-2 text-xs",
              completed ? "text-muted-foreground/70" : "text-muted-foreground",
            )}
          >
            {completed ? (
              <CircleCheckIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            ) : (
              <CircleDashedIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
            )}
            <span className="min-w-0 flex-1 truncate">{task.step}</span>
          </div>
        }
      />
      <TooltipPopup className="max-w-72" side="left">
        {task.step}
      </TooltipPopup>
    </Tooltip>
  );
}

export function HubTasks({
  plans,
  latestRunId,
}: {
  plans: readonly OrchestrationV2PlanArtifact[];
  latestRunId: RunId | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const tasks = hubTaskStack(plans, latestRunId);
  if (tasks.length === 0) return null;
  const active = tasks.filter((task) => task.status === "inProgress").length;
  // What is left keeps the stack's order (in progress, then pending in plan
  // order); finished steps fold behind one disclosure so they stop competing
  // with the work that is still moving.
  const remaining = tasks.filter((task) => task.status !== "completed");
  const completed = tasks.filter((task) => task.status === "completed");
  const shown = expanded ? remaining : remaining.slice(0, COLLAPSED_ROWS);
  const overflow = remaining.length > COLLAPSED_ROWS;
  const percent = Math.round((completed.length / tasks.length) * 100);
  return (
    <HubSection
      title="Tasks"
      icon={<ListChecksIcon />}
      description="The agent's own plan for this thread: what it is on now, what is next, and what it finished."
      count={active > 0 ? active : undefined}
      countLabel={`${active} in progress`}
      countTone="primary"
      action={
        <span className="text-2xs tabular-nums text-muted-foreground">
          {completed.length} of {tasks.length} done
        </span>
      }
    >
      <div
        aria-label="Tasks done"
        aria-valuemax={tasks.length}
        aria-valuemin={0}
        aria-valuenow={completed.length}
        className="mx-1 mb-1.5 h-1 overflow-hidden rounded-full bg-foreground/8"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      {shown.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
      {overflow ? (
        <HubDisclosure onToggle={() => setExpanded((it) => !it)} open={expanded}>
          {expanded ? "Show less" : `${remaining.length - COLLAPSED_ROWS} more to do`}
        </HubDisclosure>
      ) : null}
      {completed.length > 0 ? (
        <>
          <HubDisclosure onToggle={() => setDoneOpen((it) => !it)} open={doneOpen}>
            {remaining.length === 0 ? `All ${completed.length} done` : `${completed.length} done`}
          </HubDisclosure>
          {doneOpen ? completed.map((task) => <TaskRow key={task.id} task={task} />) : null}
        </>
      ) : null}
    </HubSection>
  );
}
