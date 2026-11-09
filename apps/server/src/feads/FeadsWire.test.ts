import { describe, expect, it } from "vite-plus/test";

import { AGENTWATCH_FIXTURE, ISSUES_FIXTURE, NOTIFICATIONS_FIXTURE } from "./feadsWire.fixtures.ts";
import {
  decodeAck,
  decodeAgentwatch,
  decodeBeadComments,
  decodeBeadShow,
  decodeIssues,
  decodeNotifications,
  subagentCount,
  wireTimeToIso,
  wireTimeToMs,
} from "./FeadsWire.ts";

describe("time normalisation", () => {
  it("accepts epoch ms and ISO, treats 0 and junk as unset", () => {
    expect(wireTimeToMs(1_788_552_000_000)).toBe(1_788_552_000_000);
    expect(wireTimeToMs("2026-09-04T18:00:00.000Z")).toBe(Date.UTC(2026, 8, 4, 18));
    expect(wireTimeToMs(0)).toBeNull();
    expect(wireTimeToMs(null)).toBeNull();
    expect(wireTimeToMs(undefined)).toBeNull();
    expect(wireTimeToMs("not a date")).toBeNull();
    expect(wireTimeToIso(1_788_552_000_000)).toBe("2026-09-04T20:00:00.000Z");
    expect(wireTimeToIso("2026-09-04T18:00:00Z")).toBe("2026-09-04T18:00:00.000Z");
    expect(wireTimeToIso(0)).toBeNull();
  });

  it("counts subagents from a list or a number", () => {
    expect(subagentCount([1, 2, 3])).toBe(3);
    expect(subagentCount(4)).toBe(4);
    expect(subagentCount(2.9)).toBe(2);
    expect(subagentCount(-1)).toBe(0);
    expect(subagentCount(null)).toBe(0);
    expect(subagentCount({ count: 3 })).toBe(0);
  });
});

describe("decodeAgentwatch", () => {
  it("maps the contract shape and tolerates unknown fields and kinds", () => {
    const outcome = decodeAgentwatch(200, AGENTWATCH_FIXTURE);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.actor).toBe("alice-agent");
    expect(outcome.data.generatedAt).toBe(1_788_552_000_000);
    expect(outcome.data.stats).toEqual({
      activeAgents: 2,
      registeredAgents: 13,
      activeIssues: 3,
      sharedDiscussions: 1,
    });
    expect(outcome.data.agents).toHaveLength(3);
    const alice = outcome.data.agents[0]!;
    expect(alice).toMatchObject({
      actor: "alice-agent",
      displayName: "Alice (Agent)",
      kind: "human",
      registered: true,
      itemCount: 2,
      flare: "demo-8v0",
    });
    expect(alice.issues.map((issue) => issue.id)).toEqual(["demo-8v0", "demo-qmk"]);
    expect(alice.runtimeSessions).toEqual([
      { sessionId: "s1", runtimeId: "p3", lastSeen: 1_788_551_950_000, subagentCount: 3 },
      { sessionId: "s2", runtimeId: "phi", lastSeen: null, subagentCount: 4 },
    ]);
    expect(outcome.data.agents[2]).toMatchObject({ kind: "unknown", lastSeen: null, issues: [] });
    expect(outcome.data.discussions[0]).toEqual({
      id: "demo-dis",
      boardId: "demo",
      title: "Where should the token live?",
      status: "open",
      participants: ["alice-agent", "bob-phi"],
      latestComment: "secret store",
    });
  });

  it("derives stats when feads omits them", () => {
    const outcome = decodeAgentwatch(200, {
      ok: true,
      actor: "x",
      snapshot: { agents: AGENTWATCH_FIXTURE.snapshot.agents, discussions: [] },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data.stats).toEqual({
      activeAgents: 2,
      registeredAgents: 3,
      activeIssues: 3,
      sharedDiscussions: 0,
    });
  });

  it("degrades a 404 (HTML page, no JSON) to missing rather than an error", () => {
    expect(decodeAgentwatch(404, null)).toEqual({ kind: "missing" });
  });

  it("classifies refusals, server errors and junk", () => {
    expect(decodeAgentwatch(401, { ok: false, error: "not_identified" })).toEqual({
      kind: "unauthorized",
      error: "not_identified",
    });
    expect(decodeAgentwatch(403, null)).toEqual({ kind: "unauthorized", error: "not_identified" });
    expect(decodeAgentwatch(502, null)).toEqual({ kind: "error", error: "http_502" });
    expect(decodeAgentwatch(200, null)).toEqual({ kind: "error", error: "not_json" });
    expect(decodeAgentwatch(200, { ok: false, error: "scope" })).toEqual({
      kind: "error",
      error: "scope",
    });
    expect(decodeAgentwatch(200, "a string")).toEqual({
      kind: "error",
      error: "unexpected_shape",
    });
    // A 200 with no snapshot is an empty board, not a failure.
    expect(decodeAgentwatch(200, { ok: true, actor: "x" })).toMatchObject({
      kind: "ok",
      data: { agents: [], discussions: [] },
    });
  });
});

describe("decodeIssues", () => {
  it("maps issues and normalises timestamps and blockers", () => {
    const outcome = decodeIssues(200, ISSUES_FIXTURE);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data).toHaveLength(2);
    expect(outcome.data[0]).toEqual({
      id: "demo-8v0",
      title: "P1 settings card",
      status: "in_progress",
      issueType: "task",
      priority: 2,
      assignee: "alice-agent",
      labels: ["p3code"],
      boardId: "demo",
      boardName: "Demo",
      createdAt: "2026-09-04T18:00:00.000Z",
      updatedAt: "2026-09-04T19:58:20.000Z",
      closedAt: null,
      blockedBy: ["demo-uzx", "demo-0gn"],
    });
    expect(outcome.data[1]).toMatchObject({
      id: "demo-abc",
      title: "bare bead",
      status: "",
      labels: [],
      blockedBy: [],
      boardId: null,
    });
  });

  it("degrades a 404 to missing", () => {
    expect(decodeIssues(404, null)).toEqual({ kind: "missing" });
  });
});

describe("decodeNotifications", () => {
  it("maps the live shape, blanks to null, unknown types to other", () => {
    const outcome = decodeNotifications(200, NOTIFICATIONS_FIXTURE);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.actor).toBe("alice-agent");
    expect(outcome.data.unreadCount).toBe(98);
    expect(outcome.data.notifications[0]).toEqual({
      id: "n_demo_one",
      boardId: "demo",
      type: "update_on_commented",
      issueId: "demo-abc",
      issueTitle: "Update example documentation",
      actor: null,
      snippet: "Status: in_progress → closed",
      relatedIssue: null,
      createdAt: "2026-09-04T20:00:25.009Z",
      readAt: null,
      handledAt: null,
      url: "#/issues?issue=demo-abc",
    });
    expect(outcome.data.notifications[1]).toMatchObject({
      type: "mention",
      actor: "bob-phi",
      relatedIssue: "demo-8v0",
    });
    expect(outcome.data.notifications[2]).toMatchObject({ id: "n_weird", type: "other" });
  });

  it("falls back to the row count when unread_count is absent", () => {
    const outcome = decodeNotifications(200, {
      ok: true,
      notifications: [{ id: "a" }, { id: "b" }],
    });
    expect(outcome.kind === "ok" && outcome.data.unreadCount).toBe(2);
  });
});

describe("decodeAck", () => {
  it("reads whichever count key feads uses", () => {
    expect(decodeAck(200, { ok: true, acknowledged: 3 })).toMatchObject({
      kind: "ok",
      data: { ok: true, count: 3 },
    });
    expect(decodeAck(200, { ok: true, updated: 1 })).toMatchObject({ data: { count: 1 } });
    expect(decodeAck(200, { ok: true })).toMatchObject({ data: { ok: true, count: null } });
    expect(decodeAck(401, null)).toEqual({ kind: "unauthorized", error: "not_identified" });
    expect(decodeAck(404, null)).toEqual({ kind: "missing" });
  });
});

describe("decodeBeadShow", () => {
  // Shape of the MCP `show` tool's payload, abridged.
  const SHOWN = {
    id: "demo-oru",
    title: "Open a bead as a P3 thread",
    description: "Beads filed by outside agents need a way into a coding thread.",
    design: null,
    acceptance_criteria: "- A button on the row",
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: "bob-phi",
    labels: ["feads", "p3code"],
    created_at: "2026-09-15T00:45:26Z",
    updated_at: "2026-09-15T00:45:26Z",
    closed_at: null,
  };

  it("maps the row the same way the listing does and keeps the long-form fields", () => {
    const bead = decodeBeadShow(SHOWN);
    expect(bead?.issue).toMatchObject({
      id: "demo-oru",
      title: "Open a bead as a P3 thread",
      status: "open",
      priority: 2,
      issueType: "task",
      assignee: "bob-phi",
      labels: ["feads", "p3code"],
      blockedBy: [],
    });
    expect(bead?.detail).toEqual({
      description: "Beads filed by outside agents need a way into a coding thread.",
      acceptanceCriteria: "- A button on the row",
      design: null,
    });
  });

  it("is null for anything that is not a bead", () => {
    expect(decodeBeadShow({ error: "not found" })).toBeNull();
    expect(decodeBeadShow("demo-oru")).toBeNull();
    expect(decodeBeadShow(null)).toBeNull();
  });
});

describe("decodeBeadComments", () => {
  it("reads a bare list or a wrapped one, dropping empty rows", () => {
    const rows = [
      { author: "bob-phi", text: "Survey results", created_at: "2026-09-15T00:49:07Z" },
      { actor: "luna", body: "picked it up" },
      { author: "ghost", text: "   " },
    ];
    expect(decodeBeadComments(rows)).toEqual([
      { author: "bob-phi", text: "Survey results", createdAt: "2026-09-15T00:49:07.000Z" },
      { author: "luna", text: "picked it up", createdAt: null },
    ]);
    expect(decodeBeadComments({ comments: rows })).toHaveLength(2);
  });

  it("is empty for anything unreadable", () => {
    expect(decodeBeadComments(null)).toEqual([]);
    expect(decodeBeadComments("nope")).toEqual([]);
    expect(decodeBeadComments({})).toEqual([]);
  });
});
