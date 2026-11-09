import { ProviderInstanceId, ThreadId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveHubAgents, hubAgentStatusFromRun, type HubChildThread } from "./hubAgents.logic";

const parentId = ThreadId.make("thread-parent");
const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  id: string,
  fields: Partial<Record<keyof OrchestrationV2Subagent, unknown>> = {},
): OrchestrationV2Subagent {
  return {
    id,
    threadId: parentId,
    runId: "run-1",
    parentNodeId: "node-1",
    origin: "provider_native",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    childThreadId: null,
    prompt: "Look around the repo",
    title: null,
    model: "claude-sonnet-4-5",
    status: "running",
    result: null,
    startedAt: at("2026-10-01T00:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-10-01T00:00:00.000Z"),
    ...fields,
  } as unknown as OrchestrationV2Subagent;
}

function child(id: string, fields: Partial<HubChildThread> = {}): HubChildThread {
  return {
    id: ThreadId.make(id),
    title: `Child ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { model: "gpt-5.2-codex" },
    lineage: {
      parentThreadId: parentId,
      rootThreadId: parentId,
      relationshipToParent: "subagent",
    } as HubChildThread["lineage"],
    creationSource: "mcp",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:05:00.000Z",
    latestRun: {
      status: "completed",
      startedAt: "2026-10-01T00:00:01.000Z",
      completedAt: "2026-10-01T00:05:00.000Z",
    },
    ...fields,
  };
}

describe("deriveHubAgents", () => {
  it("lists live agents first, then finished ones newest-first", () => {
    const agents = deriveHubAgents({
      threadId: parentId,
      subagents: [
        subagent("done-early", {
          status: "completed",
          completedAt: at("2026-10-01T00:01:00.000Z"),
        }),
        subagent("live"),
        subagent("done-late", {
          status: "failed",
          completedAt: at("2026-10-01T00:03:00.000Z"),
        }),
      ],
      childThreads: [],
    });
    expect(agents.map((agent) => [agent.id, agent.live])).toEqual([
      ["live", true],
      ["done-late", false],
      ["done-early", false],
    ]);
  });

  it("marks T3 delegated tasks and prefers the child thread's title and model fallback", () => {
    const [agent] = deriveHubAgents({
      threadId: parentId,
      subagents: [
        subagent("task", {
          origin: "app_owned",
          model: null,
          childThreadId: "child-1",
          title: "delegate",
        }),
      ],
      childThreads: [child("child-1", { title: "Fix the tests" })],
    });
    expect(agent).toMatchObject({
      kind: "delegated",
      title: "Fix the tests",
      model: "gpt-5.2-codex",
      childThreadId: "child-1",
    });
  });

  it("adds child threads the projection does not name, from their own latest run", () => {
    const agents = deriveHubAgents({
      threadId: parentId,
      subagents: [subagent("named", { childThreadId: "child-1" })],
      childThreads: [
        child("child-1"),
        child("child-2", {
          latestRun: {
            status: "running",
            startedAt: "2026-10-01T00:02:00.000Z",
            completedAt: null,
          },
        }),
        // Forks and other threads' children are not this thread's agents.
        child("fork", {
          lineage: {
            parentThreadId: parentId,
            rootThreadId: parentId,
            relationshipToParent: "fork",
          } as HubChildThread["lineage"],
        }),
        child("other", {
          lineage: {
            parentThreadId: ThreadId.make("elsewhere"),
            rootThreadId: ThreadId.make("elsewhere"),
            relationshipToParent: "subagent",
          } as HubChildThread["lineage"],
        }),
      ],
    });
    expect(agents.map((agent) => agent.id)).toEqual(["named", "child-2"]);
    expect(agents[1]).toMatchObject({ status: "running", kind: "delegated", live: true });
  });

  it("ignores subagents recorded on another thread", () => {
    expect(
      deriveHubAgents({
        threadId: parentId,
        subagents: [subagent("x", { threadId: "thread-other" })],
        childThreads: [],
      }),
    ).toEqual([]);
  });
});

describe("hubAgentStatusFromRun", () => {
  it("maps run statuses onto subagent statuses", () => {
    expect(hubAgentStatusFromRun("queued")).toBe("pending");
    expect(hubAgentStatusFromRun("rolled_back")).toBe("cancelled");
    expect(hubAgentStatusFromRun(null)).toBe("idle");
  });
});
