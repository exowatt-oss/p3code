import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  exowattCompactPullRequestCount,
  resolveExowattSidebarRowProjectPrefix,
  resolveExowattSidebarRowVariant,
} from "./exowattSidebarDensity";

describe("resolveExowattSidebarRowVariant", () => {
  it("keeps v2's cards for live and pinned rows in comfortable mode", () => {
    for (const section of ["pinned", "active", "working"] as const) {
      expect(resolveExowattSidebarRowVariant(section, "comfortable")).toBe("card");
    }
    for (const section of ["snoozed", "settled"] as const) {
      expect(resolveExowattSidebarRowVariant(section, "comfortable")).toBe("slim");
    }
  });

  it("collapses every section, including working, in compact mode", () => {
    for (const section of ["pinned", "active", "working", "snoozed", "settled"] as const) {
      expect(resolveExowattSidebarRowVariant(section, "compact")).toBe("slim");
    }
  });
});

describe("resolveExowattSidebarRowProjectPrefix", () => {
  const base = {
    density: "compact" as const,
    grouped: false,
    scopedToOneProject: false,
    projectTitle: "DT · Dev tools",
  };

  it("shows only the distinguishing name in a mixed flat stream", () => {
    expect(resolveExowattSidebarRowProjectPrefix(base)).toBe("Dev tools");
    expect(resolveExowattSidebarRowProjectPrefix({ ...base, projectTitle: "DT" })).toBe("DT");
    expect(resolveExowattSidebarRowProjectPrefix({ ...base, projectTitle: null })).toBeNull();
  });

  it("does not repeat a project header or scoped project's name", () => {
    expect(resolveExowattSidebarRowProjectPrefix({ ...base, grouped: true })).toBeNull();
    expect(resolveExowattSidebarRowProjectPrefix({ ...base, scopedToOneProject: true })).toBeNull();
    expect(resolveExowattSidebarRowProjectPrefix({ ...base, density: "comfortable" })).toBeNull();
  });
});

describe("exowattCompactPullRequestCount", () => {
  it("uses legacy linked PRs if the v2 link list is empty", () => {
    expect(exowattCompactPullRequestCount({ pullRequests: [] }, 1)).toBe(1);
    expect(exowattCompactPullRequestCount({ pullRequests: [] })).toBe(0);
  });

  it("counts visible v2 links instead of the legacy fallback", () => {
    const link: ThreadPullRequestLink = {
      host: "github.com",
      repository: "acme/web",
      number: 42,
      url: "https://github.com/acme/web/pull/42",
      source: "manual",
      linkedAt: "2026-01-01T00:00:00Z",
      stack: null,
      snapshot: null,
    };
    expect(
      exowattCompactPullRequestCount(
        {
          pullRequests: [link, { ...link, number: 43, url: "https://github.com/acme/web/pull/43" }],
        },
        1,
      ),
    ).toBe(2);
  });
});
