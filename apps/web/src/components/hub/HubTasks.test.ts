import { RunId, type OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hubTaskStack } from "./HubTasks";

const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");

function todo(
  id: string,
  runId: RunId | null,
  steps: Array<{
    text: string;
    status: "pending" | "running" | "completed";
    durationAnchorAt?: string;
    durationMs?: number;
  }>,
): OrchestrationV2PlanArtifact {
  return {
    id,
    threadId: "thread-A",
    runId,
    nodeId: "node-1",
    status: "active",
    kind: "todo_list",
    steps: steps.map((step, index) => ({ id: `${id}-${index}`, ...step })),
  } as unknown as OrchestrationV2PlanArtifact;
}

describe("hubTaskStack", () => {
  it("puts in-progress first, then completed newest-first, then pending in plan order", () => {
    const plans = [
      todo("p1", run1, [
        { text: "A", status: "completed" },
        { text: "B", status: "completed" },
        { text: "C", status: "running" },
        { text: "D", status: "pending" },
        { text: "E", status: "pending" },
      ]),
    ];
    expect(hubTaskStack(plans, run1).map((task) => task.step)).toEqual(["C", "B", "A", "D", "E"]);
  });

  it("orders completed steps by when they finished when the server timed them", () => {
    const plans = [
      todo("p1", run1, [
        {
          text: "slow",
          status: "completed",
          durationAnchorAt: "2026-01-01T00:00:00.000Z",
          durationMs: 9000,
        },
        {
          text: "fast",
          status: "completed",
          durationAnchorAt: "2026-01-01T00:00:01.000Z",
          durationMs: 1000,
        },
      ]),
    ];
    expect(hubTaskStack(plans, run1).map((task) => task.step)).toEqual(["slow", "fast"]);
  });

  it("prefers the latest run's list, else the newest one, and skips proposed plans", () => {
    const plans = [
      todo("p1", run1, [{ text: "old", status: "completed" }]),
      todo("p2", run2, [{ text: "new", status: "running" }]),
      {
        id: "plan",
        threadId: "thread-A",
        runId: run2,
        nodeId: "node-1",
        status: "active",
        kind: "proposed_plan",
        markdown: "# Plan",
      } as unknown as OrchestrationV2PlanArtifact,
    ];
    expect(hubTaskStack(plans, run1).map((task) => task.step)).toEqual(["old"]);
    expect(hubTaskStack(plans, RunId.make("run-3")).map((task) => task.step)).toEqual(["new"]);
    expect(hubTaskStack(plans, run2)[0]?.status).toBe("inProgress");
  });

  it("is empty without a todo list", () => {
    expect(hubTaskStack([], null)).toEqual([]);
  });
});
