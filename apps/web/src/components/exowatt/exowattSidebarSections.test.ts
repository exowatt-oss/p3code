import { describe, expect, it } from "vite-plus/test";

import {
  EXOWATT_SIDEBAR_OTHER_SECTION_KEY,
  orderExowattSidebarSectionProjects,
  partitionExowattSidebarSections,
  type ExowattSidebarSectionProject,
} from "./exowattSidebarSections";

interface FakeThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

function thread(id: string, projectId: string, updatedAt = "2026-09-01T10:00:00.000Z"): FakeThread {
  return {
    id,
    environmentId: "env",
    projectId,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    archivedAt: null,
  };
}

function project(
  id: string,
  displayName: string,
  createdAt = "2026-01-01T00:00:00.000Z",
): ExowattSidebarSectionProject {
  return {
    id,
    title: displayName,
    displayName,
    createdAt,
    projectKey: `key:${id}`,
    memberProjectRefs: [{ environmentId: "env", projectId: id }],
  };
}

const alpha = project("a", "Alpha", "2026-02-01T00:00:00.000Z");
const beta = project("b", "Beta", "2026-01-01T00:00:00.000Z");

const shelves = {
  pinned: [thread("p1", "b")],
  active: [thread("a1", "a"), thread("a2", "b"), thread("a3", "a")],
  snoozed: [thread("z1", "a")],
  settled: [thread("s1", "b"), thread("s2", "zzz-unknown")],
  visibleSnoozed: [] as FakeThread[],
  renderedSettled: [thread("s1", "b")],
};

describe("partitionExowattSidebarSections", () => {
  it("returns one untitled section with the shelves untouched when grouping is off", () => {
    const sections = partitionExowattSidebarSections(shelves, {
      groupByProject: false,
      projects: [alpha, beta],
      collapsedProjectKeys: new Set(),
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.projectKey).toBeNull();
    expect(sections[0]!.title).toBeNull();
    expect(sections[0]!.active).toBe(shelves.active);
    expect(sections[0]!.threadCount).toBe(7);
  });

  it("slices every shelf per project in the given project order, keeping shelf order", () => {
    const sections = partitionExowattSidebarSections(shelves, {
      groupByProject: true,
      projects: [beta, alpha],
      collapsedProjectKeys: new Set(["key:a"]),
    });
    expect(sections.map((section) => section.title)).toEqual(["Beta", "Alpha", "Other"]);

    const [betaSection, alphaSection, other] = sections;
    expect(betaSection!.pinned.map((t) => t.id)).toEqual(["p1"]);
    expect(betaSection!.active.map((t) => t.id)).toEqual(["a2"]);
    expect(betaSection!.settled.map((t) => t.id)).toEqual(["s1"]);
    expect(betaSection!.renderedSettled.map((t) => t.id)).toEqual(["s1"]);
    expect(betaSection!.threadCount).toBe(3);
    expect(betaSection!.collapsed).toBe(false);

    expect(alphaSection!.active.map((t) => t.id)).toEqual(["a1", "a3"]);
    expect(alphaSection!.snoozed.map((t) => t.id)).toEqual(["z1"]);
    expect(alphaSection!.visibleSnoozed).toEqual([]);
    expect(alphaSection!.collapsed).toBe(true);

    // A thread whose project is not in the list is never dropped.
    expect(other!.projectKey).toBe(EXOWATT_SIDEBAR_OTHER_SECTION_KEY);
    expect(other!.settled.map((t) => t.id)).toEqual(["s2"]);
  });

  it("groups physical projects across environments by logical key", () => {
    const merged = {
      ...alpha,
      memberProjectRefs: [
        { environmentId: "env", projectId: "a" },
        { environmentId: "remote", projectId: "same-repo" },
      ],
    };
    const remoteThread = { ...thread("remote-thread", "same-repo"), environmentId: "remote" };
    const sections = partitionExowattSidebarSections(
      { ...shelves, active: [remoteThread, ...shelves.active] },
      { groupByProject: true, projects: [merged, beta], collapsedProjectKeys: new Set() },
    );
    expect(sections[0]!.active.map((item) => item.id)).toEqual(["remote-thread", "a1", "a3"]);
    expect(sections[0]!.threadCount).toBe(4);
    expect(sections.some((section) => section.title === "Other")).toBe(true);
  });

  it("omits projects without a visible thread", () => {
    const sections = partitionExowattSidebarSections(
      { ...shelves, settled: [], renderedSettled: [] },
      {
        groupByProject: true,
        projects: [alpha, beta, project("c", "Gamma")],
        collapsedProjectKeys: new Set(),
      },
    );
    expect(sections.map((section) => section.title)).toEqual(["Alpha", "Beta"]);
  });
});

describe("orderExowattSidebarSectionProjects", () => {
  const threads = [
    thread("x", "a", "2026-09-01T09:00:00.000Z"),
    thread("y", "b", "2026-09-01T12:00:00.000Z"),
  ];
  const manualRank = new Map([
    ["env:a", 1],
    ["env:b", 0],
  ]);

  it("orders by the latest thread activity", () => {
    expect(
      orderExowattSidebarSectionProjects([alpha, beta], threads, "activity", manualRank).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Beta", "Alpha"]);
  });

  it("orders by project creation when no threads decide", () => {
    expect(
      orderExowattSidebarSectionProjects([beta, alpha], [], "created_at", manualRank).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Alpha", "Beta"]);
  });

  it("orders by display name", () => {
    expect(
      orderExowattSidebarSectionProjects([beta, alpha], threads, "name", manualRank).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Alpha", "Beta"]);
  });

  it("follows the user's manual project order after a reorder", () => {
    expect(
      orderExowattSidebarSectionProjects([alpha, beta], threads, "manual", manualRank).map(
        (p) => p.displayName,
      ),
    ).toEqual(["Beta", "Alpha"]);
    expect(
      orderExowattSidebarSectionProjects(
        [alpha, beta],
        threads,
        "manual",
        new Map([
          ["env:a", 0],
          ["env:b", 1],
        ]),
      ).map((p) => p.displayName),
    ).toEqual(["Alpha", "Beta"]);
  });
});
