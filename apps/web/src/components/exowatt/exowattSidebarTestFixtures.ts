import type { SidebarThreadSummary } from "../../types";

/** Minimal sidebar thread shell for the exowatt sidebar unit tests. */
export function makeExowattSidebarThread(
  overrides: Partial<Record<keyof SidebarThreadSummary, unknown>> = {},
): SidebarThreadSummary {
  const id = (overrides.id as string | undefined) ?? "thread-1";
  return {
    environmentId: "local",
    id,
    projectId: "project-1",
    title: id,
    interactionMode: "default",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    latestRun: null,
    runtime: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    deletedAt: null,
    source: { creationSource: "web" },
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

export function exowattTestRun(
  status: string,
  times: { requestedAt?: string; startedAt?: string; completedAt?: string } = {},
): SidebarThreadSummary["latestRun"] {
  return {
    runId: "run-1",
    status,
    requestedAt: times.requestedAt ?? null,
    startedAt: times.startedAt ?? null,
    completedAt: times.completedAt ?? null,
    assistantMessageId: null,
  } as unknown as SidebarThreadSummary["latestRun"];
}

export function exowattTestRuntime(status: string): SidebarThreadSummary["runtime"] {
  return {
    status,
    activeRunId: status === "running" ? "run-1" : null,
    providerInstanceId: "codex",
    providerName: null,
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  } as unknown as SidebarThreadSummary["runtime"];
}
