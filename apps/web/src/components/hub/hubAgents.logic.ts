/**
 * The Hub's agent roster from v2 data: `projection.subagents` plus child thread shells whose
 * lineage names this thread as a subagent parent (so a child shows even when its spawning run is
 * not loaded). Live agents first in spawn order, then finished ones newest first.
 */
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import * as DateTime from "effect/DateTime";

export type HubAgentStatus = OrchestrationV2Subagent["status"];
export type HubAgentKind = "provider" | "delegated";

export interface HubAgent {
  /** Subagent node id, or the child thread id for a thread-only row. */
  readonly id: string;
  readonly kind: HubAgentKind;
  readonly title: string;
  readonly status: HubAgentStatus;
  readonly live: boolean;
  readonly model: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind | null;
  readonly childThreadId: ThreadId | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly progress: string | null;
  readonly result: string | null;
}

/** Only the shell fields the roster reads, so tests can pass plain objects. */
export interface HubChildThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: { readonly model: string };
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly creationSource?: OrchestrationV2ThreadShell["creationSource"] | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | null;
  readonly latestRun: {
    readonly status: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
}

const iso = (value: DateTime.Utc | null): string | null =>
  value === null ? null : DateTime.formatIso(value);

/** A child thread's own latest run, in subagent status terms. */
export function hubAgentStatusFromRun(status: string | null | undefined): HubAgentStatus {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
      return "pending";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    default:
      return "idle";
  }
}

function subagentTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const raw =
    subagent.title?.trim() ||
    (subagent.prompt.length > 80 ? `${subagent.prompt.slice(0, 77)}…` : subagent.prompt) ||
    "Subagent";
  return formatSubagentDisplayTitle(raw);
}

export function isHubChildAgentThread(
  thread: Pick<HubChildThread, "lineage">,
  parentThreadId: ThreadId,
): boolean {
  return (
    thread.lineage.parentThreadId === parentThreadId &&
    thread.lineage.relationshipToParent === "subagent"
  );
}

export function deriveHubAgents(input: {
  readonly threadId: ThreadId;
  readonly subagents: readonly OrchestrationV2Subagent[];
  readonly childThreads: readonly HubChildThread[];
}): readonly HubAgent[] {
  const children = input.childThreads.filter((thread) =>
    isHubChildAgentThread(thread, input.threadId),
  );
  const childById = new Map(children.map((thread) => [thread.id, thread] as const));
  const seenThreads = new Set<ThreadId>();
  const agents: HubAgent[] = [];

  for (const subagent of input.subagents) {
    if (subagent.threadId !== input.threadId) continue;
    const child = subagent.childThreadId ? childById.get(subagent.childThreadId) : undefined;
    if (subagent.childThreadId) seenThreads.add(subagent.childThreadId);
    agents.push({
      id: subagent.id,
      kind: subagent.origin === "app_owned" ? "delegated" : "provider",
      // The child thread's title is the one the sidebar shows; prefer it.
      title: formatSubagentDisplayTitle(child?.title?.trim() || subagentTitle(subagent)),
      status: subagent.status,
      live: isOrchestrationV2WorkActive(subagent.status),
      model: subagent.model ?? child?.modelSelection.model ?? null,
      providerInstanceId: subagent.providerInstanceId,
      driver: subagent.driver,
      childThreadId: subagent.childThreadId,
      startedAt: iso(subagent.startedAt),
      completedAt: iso(subagent.completedAt),
      updatedAt: DateTime.formatIso(subagent.updatedAt),
      progress: subagent.progress ?? null,
      result: subagent.result,
    });
  }

  for (const child of children) {
    if (seenThreads.has(child.id)) continue;
    const status = hubAgentStatusFromRun(child.latestRun?.status);
    agents.push({
      id: child.id,
      kind: child.creationSource === "mcp" ? "delegated" : "provider",
      title: formatSubagentDisplayTitle(child.title.trim() || "Subagent"),
      status,
      live: isOrchestrationV2WorkActive(status),
      model: child.modelSelection.model,
      providerInstanceId: child.providerInstanceId,
      driver: null,
      childThreadId: child.id,
      startedAt: child.latestRun?.startedAt ?? child.createdAt,
      completedAt: child.latestRun?.completedAt ?? null,
      updatedAt: child.updatedAt,
      progress: null,
      result: null,
    });
  }

  const live = agents.filter((agent) => agent.live);
  const done = agents
    .filter((agent) => !agent.live)
    .toSorted((left, right) =>
      (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt),
    );
  return [...live, ...done];
}

/** "Delegated task" for T3's own `delegate_task`; the provider's word otherwise. */
export function hubAgentKindLabel(kind: HubAgentKind): string {
  return kind === "delegated" ? "Delegated task" : "Subagent";
}
