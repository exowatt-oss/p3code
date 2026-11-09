import { describe, expect, it } from "@effect/vitest";
import type { ExowattFeadsIssue, ExowattFeadsNotification } from "@t3tools/contracts";

import { buildFeadsBeadBrief, FEADS_BRIEF_MAX_COMMENTS } from "./FeadsBeadBrief.ts";

const BASE = "http://127.0.0.1:3000";

const issue = (overrides: Partial<ExowattFeadsIssue> = {}): ExowattFeadsIssue => ({
  id: "demo-oru",
  title: "Open a bead as a P3 thread",
  status: "open",
  issueType: "task",
  priority: 1,
  assignee: "bob-phi",
  labels: ["p3code", "feads"],
  boardId: "demo",
  boardName: "Demo",
  createdAt: "2026-09-14T10:00:00.000Z",
  updatedAt: "2026-09-14T12:00:00.000Z",
  closedAt: null,
  blockedBy: [],
  ...overrides,
});

const notification = (
  overrides: Partial<ExowattFeadsNotification> = {},
): ExowattFeadsNotification => ({
  id: "n_1",
  boardId: "demo",
  type: "mention",
  issueId: "demo-oru",
  issueTitle: "Open a bead as a P3 thread",
  actor: "alice-agent",
  snippet: "@bob-phi can you take this one?",
  relatedIssue: null,
  createdAt: "2026-09-14T12:30:00.000Z",
  readAt: null,
  handledAt: null,
  url: "#/issues?issue=demo-oru",
  ...overrides,
});

describe("buildFeadsBeadBrief", () => {
  it("titles the thread with the bead id and its title", () => {
    const brief = buildFeadsBeadBrief({ issueId: "demo-oru", baseUrl: BASE, issue: issue() });
    expect(brief.title).toBe("demo-oru Open a bead as a P3 thread");
  });

  it("falls back to the bead id alone when nothing knows its title", () => {
    const brief = buildFeadsBeadBrief({ issueId: "demo-oru", baseUrl: BASE });
    expect(brief.title).toBe("demo-oru");
    expect(brief.text).toContain(`${BASE}/#/issues?issue=demo-oru`);
  });

  it("carries the board facts, labels, dashboard link and the closing instruction", () => {
    const brief = buildFeadsBeadBrief({
      issueId: "demo-oru",
      baseUrl: BASE,
      issue: issue({ blockedBy: ["demo-rbz"] }),
    });
    expect(brief.text).toContain(
      "**Bead:** task · priority 1 · open · assigned to bob-phi · Demo · blocked by demo-rbz",
    );
    expect(brief.text).toContain("**Labels:** p3code, feads");
    expect(brief.text).toContain(`**Dashboard:** ${BASE}/#/issues?issue=demo-oru`);
    expect(brief.text).toContain(
      "Work this item; keep its feads state honest (in_progress now, close when it lands) and comment the outcome on the bead.",
    );
  });

  it("renders the long-form fields and the most recent comments when feads sent them", () => {
    const comments = Array.from({ length: FEADS_BRIEF_MAX_COMMENTS + 3 }, (_, index) => ({
      author: `agent-${index}`,
      text: `comment ${index}`,
    }));
    const brief = buildFeadsBeadBrief({
      issueId: "demo-oru",
      baseUrl: BASE,
      issue: issue(),
      detail: {
        description: "Beads filed by outside agents need a way into a coding thread.",
        acceptanceCriteria: "- A button on the row\n- A brief on the thread",
        design: "Server-side builder, reused thread-creation path.",
        comments,
      },
    });
    expect(brief.text).toContain("## Description");
    expect(brief.text).toContain("## Acceptance criteria");
    expect(brief.text).toContain("## Design");
    expect(brief.text).toContain("- **agent-12**: comment 12");
    expect(brief.text).not.toContain("comment 2\n");
    expect(brief.text).toContain("(3 older comments not shown");
    // Detail present: no "go read the bead first" nudge.
    expect(brief.text).not.toContain("carries only what the board listing exposes");
  });

  it("says so when only the listing was available", () => {
    const brief = buildFeadsBeadBrief({ issueId: "demo-oru", baseUrl: BASE, issue: issue() });
    expect(brief.text).toContain("carries only what the board listing exposes");
  });

  it("uses an inbox row when the poller has no issue row, and says why it surfaced", () => {
    const brief = buildFeadsBeadBrief({
      issueId: "demo-oru",
      baseUrl: BASE,
      notification: notification(),
    });
    expect(brief.title).toBe("demo-oru Open a bead as a P3 thread");
    expect(brief.text).toContain("## Why this reached me");
    expect(brief.text).toContain("@bob-phi can you take this one?");
  });

  it("drops empty comments and long ones are cut, not dropped", () => {
    const brief = buildFeadsBeadBrief({
      issueId: "demo-oru",
      baseUrl: BASE,
      issue: issue(),
      detail: {
        comments: [
          { author: null, text: "   " },
          { author: null, text: "x".repeat(2_000) },
        ],
      },
    });
    expect(brief.text).toContain("- **unknown**: ");
    expect(brief.text).toContain("…");
    expect(brief.text.length).toBeLessThan(2_000);
  });
});
