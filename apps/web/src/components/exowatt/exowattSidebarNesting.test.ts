import { describe, expect, it } from "vite-plus/test";

import {
  buildExowattSidebarNesting,
  isExowattSidebarChildThread,
  summarizeExowattSidebarChildren,
} from "./exowattSidebarNesting";
import {
  exowattTestRuntime,
  makeExowattSidebarThread as makeThread,
} from "./exowattSidebarTestFixtures";
import type { SidebarThreadSummary } from "../../types";

const keyOf = (thread: SidebarThreadSummary) => `${thread.environmentId}:${thread.id}`;
const at = (minute: number) => `2026-03-09T10:${String(minute).padStart(2, "0")}:00.000Z`;

function child(
  id: string,
  parentThreadId: string | null,
  overrides: Parameters<typeof makeThread>[0] = {},
  rootThreadId = parentThreadId ?? id,
) {
  return makeThread({
    id,
    lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId },
    ...overrides,
  });
}

const childIds = (
  nesting: ReturnType<typeof buildExowattSidebarNesting<SidebarThreadSummary>>,
  parentKey: string,
) => (nesting.childrenByParentKey.get(parentKey) ?? []).map((thread) => thread.id);

describe("buildExowattSidebarNesting", () => {
  it("groups provider subagents and delegated tasks under their parent, newest first", () => {
    const threads = [
      makeThread({ id: "parent" }),
      child("sub-old", "parent", { latestUserMessageAt: at(1) }),
      child("delegated", "parent", {
        latestUserMessageAt: at(9),
        source: { creationSource: "mcp" },
      }),
      makeThread({ id: "loner" }),
    ];
    const nesting = buildExowattSidebarNesting(threads, keyOf);
    expect(childIds(nesting, "local:parent")).toEqual(["delegated", "sub-old"]);
    expect(nesting.childrenByParentKey.has("local:loner")).toBe(false);
    expect(nesting.parentKeyByChildKey.get("local:sub-old")).toBe("local:parent");
  });

  it("flattens grandchildren under the top-level ancestor", () => {
    const threads = [
      makeThread({ id: "root" }),
      child("child", "root"),
      child("grandchild", "child", {}, "root"),
    ];
    const nesting = buildExowattSidebarNesting(threads, keyOf);
    expect(childIds(nesting, "local:root").toSorted()).toEqual(["child", "grandchild"]);
    expect(nesting.childrenByParentKey.has("local:child")).toBe(false);
    expect(nesting.parentKeyByChildKey.get("local:grandchild")).toBe("local:root");
  });

  it("falls back to the root thread when the direct parent is missing", () => {
    const threads = [makeThread({ id: "root" }), child("orphan", "gone", {}, "root")];
    expect(childIds(buildExowattSidebarNesting(threads, keyOf), "local:root")).toEqual(["orphan"]);
  });

  it("keeps forks top-level and never surfaces an orphan subagent", () => {
    const fork = makeThread({
      id: "fork",
      lineage: { parentThreadId: "parent", relationshipToParent: "fork", rootThreadId: "parent" },
    });
    const threads = [makeThread({ id: "parent" }), fork, child("orphan", "missing")];
    const nesting = buildExowattSidebarNesting(threads, keyOf);
    expect(isExowattSidebarChildThread(fork)).toBe(false);
    expect(nesting.childrenByParentKey.size).toBe(0);
    expect(nesting.parentKeyByChildKey.has("local:orphan")).toBe(false);
  });

  it("drops archived children and does not cross environments", () => {
    const threads = [
      makeThread({ id: "parent" }),
      child("archived", "parent", { archivedAt: at(5) }),
      child("remote-child", "parent", { environmentId: "remote" }),
    ];
    const nesting = buildExowattSidebarNesting(threads, keyOf);
    expect(nesting.childrenByParentKey.size).toBe(0);
  });

  it("survives lineage cycles", () => {
    const threads = [child("a", "b"), child("b", "a")];
    expect(buildExowattSidebarNesting(threads, keyOf).childrenByParentKey.size).toBe(0);
  });
});

describe("summarizeExowattSidebarChildren", () => {
  it("rolls up running and needs-you counts and the latest activity", () => {
    const summary = summarizeExowattSidebarChildren([
      child("running", "p", { runtime: exowattTestRuntime("running"), latestUserMessageAt: at(3) }),
      child("approval", "p", { hasPendingApprovals: true, latestUserMessageAt: at(7) }),
      child("done", "p", { latestUserMessageAt: at(1) }),
    ]);
    expect(summary).toEqual({
      count: 3,
      running: 1,
      needsUser: 1,
      latestActivityMs: Date.parse(at(7)),
    });
  });
});
