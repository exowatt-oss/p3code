import { describe, expect, it } from "vite-plus/test";

import {
  EXOWATT_SIDEBAR_FILTER_DEFAULTS,
  countActiveExowattSidebarFilters,
  exowattSidebarFilterWindowMs,
  exowattSidebarThreadNeedsUser,
  filterExowattOlderSettledScopes,
  filterExowattSidebarThreads,
  isExowattSidebarFilterActive,
  threadPassesExowattSidebarFilter,
  type ExowattSidebarFilterState,
} from "./exowattSidebarFilter";
import {
  exowattTestRun,
  exowattTestRuntime,
  makeExowattSidebarThread as makeThread,
} from "./exowattSidebarTestFixtures";
import type { SidebarThreadSummary } from "../../types";

const NOW = Date.parse("2026-03-09T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR_MS).toISOString();

function filterState(
  overrides: Partial<ExowattSidebarFilterState> = {},
): ExowattSidebarFilterState {
  return { ...EXOWATT_SIDEBAR_FILTER_DEFAULTS, ...overrides };
}

function passes(
  thread: SidebarThreadSummary,
  filter: ExowattSidebarFilterState,
  extra: {
    isCurrentThread?: boolean;
    primaryEnvironmentId?: string | null;
    activityMs?: number;
    descendantNeedsUser?: boolean;
  } = {},
): boolean {
  return threadPassesExowattSidebarFilter({
    thread,
    filter,
    nowMs: NOW,
    primaryEnvironmentId:
      extra.primaryEnvironmentId === undefined ? "local" : extra.primaryEnvironmentId,
    ...(extra.isCurrentThread === undefined ? {} : { isCurrentThread: extra.isCurrentThread }),
    ...(extra.activityMs === undefined ? {} : { activityMs: extra.activityMs }),
    ...(extra.descendantNeedsUser === undefined
      ? {}
      : { descendantNeedsUser: extra.descendantNeedsUser }),
  });
}

/** A thread last touched `hours` ago, by a user message. */
const touched = (hours: number, overrides: Parameters<typeof makeThread>[0] = {}) =>
  makeThread({
    createdAt: hoursAgo(hours + 1),
    updatedAt: hoursAgo(hours),
    latestUserMessageAt: hoursAgo(hours),
    ...overrides,
  });

describe("filter state helpers", () => {
  it("defaults to showing everything", () => {
    expect(EXOWATT_SIDEBAR_FILTER_DEFAULTS).toEqual({
      window: "all",
      thisDeviceOnly: false,
      needsMeOnly: false,
      hideSettled: false,
    });
    expect(isExowattSidebarFilterActive(EXOWATT_SIDEBAR_FILTER_DEFAULTS)).toBe(false);
    expect(countActiveExowattSidebarFilters(EXOWATT_SIDEBAR_FILTER_DEFAULTS)).toBe(0);
  });

  it("counts every non-default filter for the trigger badge", () => {
    expect(countActiveExowattSidebarFilters(filterState({ window: "48h" }))).toBe(1);
    expect(
      countActiveExowattSidebarFilters(
        filterState({ window: "7d", thisDeviceOnly: true, needsMeOnly: true, hideSettled: true }),
      ),
    ).toBe(4);
    expect(isExowattSidebarFilterActive(filterState({ hideSettled: true }))).toBe(true);
  });

  it("maps windows to durations", () => {
    expect(exowattSidebarFilterWindowMs("all")).toBeNull();
    expect(exowattSidebarFilterWindowMs("24h")).toBe(24 * HOUR_MS);
    expect(exowattSidebarFilterWindowMs("48h")).toBe(48 * HOUR_MS);
    expect(exowattSidebarFilterWindowMs("7d")).toBe(7 * 24 * HOUR_MS);
  });
});

describe("time window", () => {
  const fresh = touched(2);
  const yesterday = touched(30);
  const lastWeek = touched(100);
  const ancient = touched(24 * 10);

  it("keeps everything on All time", () => {
    for (const thread of [fresh, yesterday, lastWeek, ancient]) {
      expect(passes(thread, filterState())).toBe(true);
    }
  });

  it("applies the 24h, 48h and 7d windows", () => {
    expect(
      [fresh, yesterday, lastWeek, ancient].map((t) => passes(t, filterState({ window: "24h" }))),
    ).toEqual([true, false, false, false]);
    expect(
      [fresh, yesterday, lastWeek, ancient].map((t) => passes(t, filterState({ window: "48h" }))),
    ).toEqual([true, true, false, false]);
    expect(
      [fresh, yesterday, lastWeek, ancient].map((t) => passes(t, filterState({ window: "7d" }))),
    ).toEqual([true, true, true, false]);
  });

  it("includes a thread touched exactly on the boundary and excludes one a millisecond older", () => {
    const edge = new Date(NOW - 48 * HOUR_MS).toISOString();
    const past = new Date(NOW - 48 * HOUR_MS - 1).toISOString();
    const window = filterState({ window: "48h" });
    expect(passes(makeThread({ createdAt: edge, updatedAt: edge }), window)).toBe(true);
    expect(passes(makeThread({ createdAt: past, updatedAt: past }), window)).toBe(false);
  });

  it("counts the latest run as activity, not only user messages", () => {
    const thread = touched(72, {
      latestRun: exowattTestRun("completed", {
        requestedAt: hoursAgo(72),
        completedAt: hoursAgo(3),
      }),
    });
    expect(passes(thread, filterState({ window: "24h" }))).toBe(true);
  });

  it("counts reopening a settled thread as activity", () => {
    expect(passes(touched(72, { unsettledAt: hoursAgo(1) }), filterState({ window: "24h" }))).toBe(
      true,
    );
  });

  it("ignores bookkeeping updatedAt bumps once a real activity signal exists", () => {
    // v2 bumps updatedAt for pins, order keys, auto-settle and restart recovery.
    const restarted = touched(72, { updatedAt: hoursAgo(0.5) });
    expect(passes(restarted, filterState({ window: "24h" }))).toBe(false);
  });

  it("keeps in-flight work however old its last stamp", () => {
    const running = touched(24 * 9, { runtime: exowattTestRuntime("running") });
    expect(passes(running, filterState({ window: "24h" }))).toBe(true);
  });

  it("uses a rolled-up activity override for parents with subagents", () => {
    expect(passes(lastWeek, filterState({ window: "24h" }), { activityMs: NOW - HOUR_MS })).toBe(
      true,
    );
  });

  it("drops threads with no parseable timestamp once the window narrows", () => {
    const broken = makeThread({ createdAt: "nope", updatedAt: "nope" });
    expect(passes(broken, filterState())).toBe(true);
    expect(passes(broken, filterState({ window: "7d" }))).toBe(false);
  });
});

describe("this device only", () => {
  const remote = touched(1, { environmentId: "remote" });

  it("hides threads from other environments", () => {
    expect(passes(remote, filterState({ thisDeviceOnly: true }))).toBe(false);
    expect(passes(touched(1), filterState({ thisDeviceOnly: true }))).toBe(true);
  });

  it("does nothing while the primary environment is unknown", () => {
    expect(
      passes(remote, filterState({ thisDeviceOnly: true }), { primaryEnvironmentId: null }),
    ).toBe(true);
  });
});

describe("needs me only", () => {
  it("keeps threads with pending approvals or pending user input", () => {
    const needsMe = filterState({ needsMeOnly: true });
    expect(passes(touched(1, { hasPendingApprovals: true }), needsMe)).toBe(true);
    expect(passes(touched(1, { hasPendingUserInput: true }), needsMe)).toBe(true);
  });

  it("keeps a thread with an actionable plan waiting on a decision", () => {
    const planReady = touched(1, {
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestRun: exowattTestRun("completed", { completedAt: hoursAgo(1) }),
    });
    expect(exowattSidebarThreadNeedsUser(planReady)).toBe(true);
    expect(passes(planReady, filterState({ needsMeOnly: true }))).toBe(true);
  });

  it("hides idle and merely working threads", () => {
    const needsMe = filterState({ needsMeOnly: true });
    expect(passes(touched(1), needsMe)).toBe(false);
    expect(passes(touched(1, { runtime: exowattTestRuntime("running") }), needsMe)).toBe(false);
  });

  it("keeps a parent whose subagent waits on the user", () => {
    expect(
      passes(touched(1), filterState({ needsMeOnly: true }), { descendantNeedsUser: true }),
    ).toBe(true);
  });

  it("never lets the window or hide-settled hide work waiting on the user", () => {
    const waiting = touched(24 * 9, { hasPendingApprovals: true, settledOverride: "settled" });
    expect(passes(waiting, filterState({ window: "24h", hideSettled: true }))).toBe(true);
    expect(
      passes(touched(24 * 9), filterState({ window: "24h" }), { descendantNeedsUser: true }),
    ).toBe(true);
  });
});

describe("hide settled", () => {
  it("hides settled rows and leaves other shelves alone", () => {
    const hide = filterState({ hideSettled: true });
    expect(passes(touched(1, { settledOverride: "settled" }), hide)).toBe(false);
    expect(passes(touched(1, { settledOverride: "active" }), hide)).toBe(true);
    expect(passes(touched(1), hide)).toBe(true);
  });

  it("does not hide settled rows when the toggle is off", () => {
    expect(passes(touched(1, { settledOverride: "settled" }), filterState())).toBe(true);
  });
});

describe("the currently open thread is never hidden", () => {
  it("survives every filter at once, including a settled remote row", () => {
    const thread = touched(24 * 30, { environmentId: "remote", settledOverride: "settled" });
    const everything = filterState({
      window: "24h",
      thisDeviceOnly: true,
      needsMeOnly: true,
      hideSettled: true,
    });
    expect(passes(thread, everything)).toBe(false);
    expect(passes(thread, everything, { isCurrentThread: true })).toBe(true);
  });
});

describe("filterExowattSidebarThreads", () => {
  const threads = [touched(1, { id: "a" }), touched(60, { id: "b" }), touched(1, { id: "c" })];

  it("returns the same array when no filter is active", () => {
    const result = filterExowattSidebarThreads(threads, {
      filter: filterState(),
      nowMs: NOW,
      primaryEnvironmentId: "local",
    });
    expect(result).toBe(threads);
  });

  it("applies the predicate per thread and honours the open-thread escape hatch", () => {
    const filter = filterState({ window: "48h" });
    const base = { filter, nowMs: NOW, primaryEnvironmentId: "local" };
    expect(filterExowattSidebarThreads(threads, base).map((t) => t.id)).toEqual(["a", "c"]);
    expect(
      filterExowattSidebarThreads(threads, { ...base, isCurrentThread: (t) => t.id === "b" }).map(
        (t) => t.id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      filterExowattSidebarThreads(threads, {
        ...base,
        activityMsOf: (t) => (t.id === "b" ? NOW : Number.NEGATIVE_INFINITY),
      }).map((t) => t.id),
    ).toEqual(["b"]);
  });
});

describe("filterExowattOlderSettledScopes", () => {
  const scopes = [
    { environmentId: "local", projectIds: null },
    { environmentId: "remote", projectIds: null },
  ];
  const narrow = (
    filter: ExowattSidebarFilterState,
    primaryEnvironmentId: string | null = "local",
  ) =>
    filterExowattOlderSettledScopes(scopes, { filter, primaryEnvironmentId }).map(
      (scope) => scope.environmentId,
    );

  it("pages older settled threads only where a filter can still show them", () => {
    expect(narrow(filterState())).toEqual(["local", "remote"]);
    expect(narrow(filterState({ window: "7d" }))).toEqual(["local", "remote"]);
    expect(narrow(filterState({ hideSettled: true }))).toEqual([]);
    expect(narrow(filterState({ needsMeOnly: true }))).toEqual([]);
    expect(narrow(filterState({ thisDeviceOnly: true }))).toEqual(["local"]);
    expect(narrow(filterState({ thisDeviceOnly: true }), null)).toEqual(["local", "remote"]);
  });
});
