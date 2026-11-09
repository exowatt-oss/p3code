import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatElapsedDurationLabel } from "~/timestampFormat";

type ActivityItem = Extract<
  OrchestrationV2TurnItem,
  { type: "dynamic_tool" | "command_execution" | "file_change" | "file_search" | "web_search" }
>;

function isActivityItem(item: OrchestrationV2TurnItem): item is ActivityItem {
  switch (item.type) {
    case "dynamic_tool":
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
      return true;
    default:
      return false;
  }
}

function actionLabel(item: ActivityItem): string | null {
  const title = item.title?.trim();
  if (title) return title;
  switch (item.type) {
    case "dynamic_tool":
      return item.toolName;
    case "command_execution":
      return "Command"; // Never echo command input here; it may contain secrets.
    case "file_change":
      return `Edit ${item.fileName}`;
    case "file_search":
      return "File search";
    case "web_search":
      return "Web search";
  }
}

export function deriveRunningSubagentActivity(
  input: {
    readonly status: string;
    readonly startedAt: string | null;
    readonly updatedAt: string | null;
    readonly progress: string | null;
    readonly childTurnItems: readonly OrchestrationV2TurnItem[];
  },
  nowMs: number,
): { readonly age: string; readonly action: string | null; readonly idle: boolean } | null {
  if (input.status !== "running") return null;
  const startedMs = input.startedAt ? Date.parse(input.startedAt) : NaN;
  // The child's own tools are evidence of activity. A parent progress receipt is
  // only a fallback: bare subagent.updatedAt can also mean a metadata change.
  let latestTool: ActivityItem | null = null;
  let latestAt = -Infinity;
  for (const item of input.childTurnItems) {
    if (!isActivityItem(item)) continue;
    const at = DateTime.toEpochMillis(item.updatedAt);
    if (at > latestAt && (Number.isNaN(startedMs) || at >= startedMs)) {
      latestTool = item;
      latestAt = at;
    }
  }
  const progress = input.progress?.replace(/\s+/g, " ").trim();
  const at = latestTool ? latestAt : Date.parse(input.updatedAt ?? "");
  if (!latestTool && !progress) return null;
  if (!Number.isFinite(at) || at > nowMs || at < 0) return null;
  const duration = formatElapsedDurationLabel(new Date(at).toISOString(), nowMs);
  if (!duration) return null;
  const rawAction = latestTool ? actionLabel(latestTool) : progress;
  const action =
    rawAction && rawAction.length > 60 ? `${rawAction.slice(0, 59).trimEnd()}…` : rawAction || null;
  const label = latestTool ? "last activity" : "last update";
  return {
    age: duration === "just now" ? `${label} just now` : `${label} ${duration} ago`,
    action,
    idle: nowMs - at >= 5 * 60_000,
  };
}
