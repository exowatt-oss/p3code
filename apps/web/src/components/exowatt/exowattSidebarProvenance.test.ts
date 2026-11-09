import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import { buildExowattSidebarNesting } from "./exowattSidebarNesting";
import { buildExowattSidebarProvenance } from "./exowattSidebarProvenance";
import { makeExowattSidebarThread as makeThread } from "./exowattSidebarTestFixtures";

const keyOf = (thread: SidebarThreadSummary) => `${thread.environmentId}:${thread.id}`;
const child = (id: string, parentThreadId: string, rootThreadId = parentThreadId) =>
  makeThread({
    id,
    lineage: { parentThreadId, rootThreadId, relationshipToParent: "subagent" },
  });

function provenance(threads: SidebarThreadSummary[]) {
  return buildExowattSidebarProvenance(threads, buildExowattSidebarNesting(threads, keyOf), keyOf);
}

describe("buildExowattSidebarProvenance", () => {
  it("does not repeat the origin on a child nested directly beneath its parent", () => {
    expect(provenance([makeThread({ id: "parent" }), child("child", "parent")]).size).toBe(0);
  });

  it("labels a flattened grandchild with its direct parent rather than its visual root", () => {
    const origins = provenance([
      makeThread({ id: "root" }),
      child("middle", "root"),
      child("grandchild", "middle", "root"),
    ]);
    expect(origins.get("local:grandchild")).toEqual({
      environmentId: "local",
      id: "middle",
      title: "middle",
    });
    expect(origins.has("local:middle")).toBe(false);
  });

  it("labels top-level forks, preferring the actual run source", () => {
    const origins = provenance([
      makeThread({ id: "creator" }),
      makeThread({ id: "other" }),
      makeThread({
        id: "fork",
        lineage: { parentThreadId: "other", relationshipToParent: "fork", rootThreadId: "other" },
        forkedFrom: { type: "run", threadId: "creator", runId: "run-1" },
      }),
    ]);
    expect(origins.get("local:fork")?.title).toBe("creator");
  });

  it("does not cross environments or invent a creator for ordinary threads", () => {
    const origins = provenance([
      makeThread({ id: "parent", environmentId: "remote" }),
      makeThread({ id: "ordinary", source: { creationSource: "mcp" } }),
      child("orphan", "parent"),
    ]);
    expect(origins.has("local:ordinary")).toBe(false);
    expect(origins.get("local:orphan")).toEqual({
      environmentId: "local",
      id: "parent",
      title: null,
    });
  });
});
