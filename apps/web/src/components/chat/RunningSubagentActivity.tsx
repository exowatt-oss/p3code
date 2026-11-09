import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { useEnvironmentThread } from "~/state/threads";
import { cn } from "~/lib/utils";
import { useExowattNowMs } from "../exowatt/useExowattNowMs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { deriveRunningSubagentActivity } from "./subagentActivity.logic";

/** Subscribes to the child's transcript only while it is running; some
 * providers report no parent progress, but do stream child tool items. */
export function RunningSubagentActivity({
  environmentId,
  childThreadId,
  status,
  startedAt,
  updatedAt,
  progress,
  showAction = false,
}: {
  environmentId: EnvironmentId;
  childThreadId: ThreadId | null;
  status: string;
  startedAt: string | null;
  updatedAt: string | null;
  progress: string | null;
  showAction?: boolean;
}) {
  const nowMs = useExowattNowMs();
  const child = useEnvironmentThread(
    status === "running" ? environmentId : null,
    status === "running" ? childThreadId : null,
  );
  const childItems = Option.getOrNull(child.data)?.turnItems ?? [];
  const activity = deriveRunningSubagentActivity(
    { status, startedAt, updatedAt, progress, childTurnItems: childItems },
    nowMs,
  );
  if (!activity) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink items-baseline gap-1 overflow-hidden",
        activity.idle && "text-warning-foreground",
      )}
    >
      <span aria-hidden="true">·</span>
      <span className="truncate whitespace-nowrap tabular-nums">{activity.age}</span>
      {showAction && activity.action ? (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 max-w-32 shrink-[2] truncate" />}>
            · {activity.action}
          </TooltipTrigger>
          <TooltipPopup side="top">{activity.action}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
