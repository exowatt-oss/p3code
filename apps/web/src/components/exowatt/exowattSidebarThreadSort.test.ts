import { describe, expect, it } from "vite-plus/test";

import {
  resolveExowattSidebarActivityMs,
  resolveExowattSidebarThreadStatusGroup,
  sortExowattSidebarThreads,
} from "./exowattSidebarThreadSort";
import {
  exowattTestRun,
  exowattTestRuntime,
  makeExowattSidebarThread as makeThread,
} from "./exowattSidebarTestFixtures";

const at = (minute: number) => `2026-03-09T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ids = (threads: ReadonlyArray<{ id: string }>) => threads.map((thread) => thread.id);

describe("resolveExowattSidebarActivityMs", () => {
  it("takes the latest of user messages, run times and un-settles", () => {
    expect(
      resolveExowattSidebarActivityMs(
        makeThread({
          createdAt: at(0),
          latestUserMessageAt: at(5),
          latestRun: exowattTestRun("completed", { requestedAt: at(5), completedAt: at(20) }),
          unsettledAt: at(10),
        }),
      ),
    ).toBe(Date.parse(at(20)));
    expect(
      resolveExowattSidebarActivityMs(makeThread({ createdAt: at(0), unsettledAt: at(30) })),
    ).toBe(Date.parse(at(30)));
  });

  it("only falls back to updatedAt when no activity signal exists", () => {
    expect(
      resolveExowattSidebarActivityMs(makeThread({ createdAt: at(0), updatedAt: at(40) })),
    ).toBe(Date.parse(at(40)));
    expect(
      resolveExowattSidebarActivityMs(
        makeThread({ createdAt: at(0), latestUserMessageAt: at(5), updatedAt: at(40) }),
      ),
    ).toBe(Date.parse(at(5)));
  });

  it("returns -Infinity when nothing parses", () => {
    expect(
      resolveExowattSidebarActivityMs(makeThread({ createdAt: "bad", updatedAt: "bad" })),
    ).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("sortExowattSidebarThreads", () => {
  it("sorts by latest activity regardless of order keys and sinks malformed timestamps", () => {
    // The v2 bug: keyless threads sort by createdAt above every keyed one, so
    // an old reopened thread sat between two that were just used.
    const threads = [
      makeThread({ id: "keyed-old", activeOrderKey: "a0", latestUserMessageAt: at(1) }),
      makeThread({ id: "broken", createdAt: "bad", updatedAt: "bad" }),
      makeThread({ id: "keyless-new", latestUserMessageAt: at(30) }),
      makeThread({ id: "keyed-new", activeOrderKey: "a1", latestUserMessageAt: at(20) }),
    ];
    expect(ids(sortExowattSidebarThreads(threads, { mode: "activity" }))).toEqual([
      "keyless-new",
      "keyed-new",
      "keyed-old",
      "broken",
    ]);
  });

  it("lets a parent sort by activity rolled up from its subagents", () => {
    const threads = [
      makeThread({ id: "parent", latestUserMessageAt: at(1) }),
      makeThread({ id: "other", latestUserMessageAt: at(10) }),
    ];
    expect(
      ids(
        sortExowattSidebarThreads(threads, {
          mode: "activity",
          activityMsOf: (thread) =>
            thread.id === "parent" ? Date.parse(at(50)) : resolveExowattSidebarActivityMs(thread),
        }),
      ),
    ).toEqual(["parent", "other"]);
  });

  it("sorts newest-created threads first", () => {
    const threads = [
      makeThread({ id: "old", createdAt: at(1), latestUserMessageAt: at(50) }),
      makeThread({ id: "new", createdAt: at(9) }),
    ];
    expect(ids(sortExowattSidebarThreads(threads, { mode: "created_at" }))).toEqual(["new", "old"]);
  });

  it("sorts names case-insensitively with numeric ordering", () => {
    const threads = [
      makeThread({ id: "c", title: "thread 10" }),
      makeThread({ id: "a", title: "Thread 2" }),
      makeThread({ id: "b", title: "alpha" }),
    ];
    expect(ids(sortExowattSidebarThreads(threads, { mode: "name" }))).toEqual(["b", "a", "c"]);
  });

  it("orders running, needs-attention, then idle, newest first inside a group", () => {
    const threads = [
      makeThread({ id: "idle", latestUserMessageAt: at(59) }),
      makeThread({ id: "approval", hasPendingApprovals: true, latestUserMessageAt: at(1) }),
      makeThread({
        id: "failed",
        runtime: exowattTestRuntime("failed"),
        latestUserMessageAt: at(2),
      }),
      makeThread({ id: "running", runtime: exowattTestRuntime("running") }),
    ];
    expect(threads.map(resolveExowattSidebarThreadStatusGroup)).toEqual([
      "idle",
      "needs-attention",
      "needs-attention",
      "running",
    ]);
    expect(ids(sortExowattSidebarThreads(threads, { mode: "status" }))).toEqual([
      "running",
      "failed",
      "approval",
      "idle",
    ]);
  });

  it("keeps pinned threads first without disturbing their order", () => {
    const threads = [
      makeThread({ id: "pinned-b", pinnedAt: at(1), latestUserMessageAt: at(1) }),
      makeThread({ id: "loose", latestUserMessageAt: at(50) }),
      makeThread({ id: "pinned-a", pinnedAt: at(2), latestUserMessageAt: at(40) }),
    ];
    expect(ids(sortExowattSidebarThreads(threads, { mode: "activity" }))).toEqual([
      "pinned-b",
      "pinned-a",
      "loose",
    ]);
  });

  it("reverses each computed mode, still sinking malformed timestamps and keeping pins first", () => {
    const threads = [
      makeThread({ id: "pinned", pinnedAt: at(1), title: "m", latestUserMessageAt: at(1) }),
      makeThread({ id: "old", title: "a", createdAt: at(1), latestUserMessageAt: at(10) }),
      makeThread({ id: "broken", title: "z", createdAt: "bad", updatedAt: "bad" }),
      makeThread({
        id: "new",
        title: "b",
        createdAt: at(5),
        runtime: exowattTestRuntime("running"),
        latestUserMessageAt: at(30),
      }),
    ];
    const sorted = (mode: "activity" | "created_at" | "name" | "status") =>
      ids(sortExowattSidebarThreads(threads, { mode, reversed: true }));
    expect(sorted("activity")).toEqual(["pinned", "old", "new", "broken"]);
    expect(sorted("created_at")).toEqual(["pinned", "old", "new", "broken"]);
    expect(sorted("name")).toEqual(["pinned", "broken", "new", "old"]);
    expect(sorted("status")).toEqual(["pinned", "old", "broken", "new"]);
  });

  it("keeps upstream's drag order in Manual mode", () => {
    const threads = [
      makeThread({ id: "second", activeOrderKey: "a2", latestUserMessageAt: at(50) }),
      makeThread({ id: "first", activeOrderKey: "a1", latestUserMessageAt: at(1) }),
    ];
    expect(ids(sortExowattSidebarThreads(threads, { mode: "manual" }))).toEqual([
      "first",
      "second",
    ]);
  });
});
