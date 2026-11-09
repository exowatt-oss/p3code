/** Synthetic Feads wire examples shared by decoder and bridge tests. */
/** Synthetic agentwatch example with extra unknown fields. */
export const AGENTWATCH_FIXTURE = {
  ok: true,
  actor: "alice-agent",
  snapshot: {
    generated_at: 1_788_552_000_000,
    stats: { active_agents: 2, registered_agents: 13, active_issues: 3, shared_discussions: 1 },
    agents: [
      {
        actor: "alice-agent",
        display_name: "Alice (Agent)",
        kind: "human",
        registered: true,
        item_count: 2,
        latest_activity: 1_788_551_900_000,
        last_seen: 1_788_551_950_000,
        flare: {
          actor: "alice-agent",
          board_id: "demo",
          issue_id: "demo-8v0",
          heartbeat_at: 1_788_551_950_000,
          liveness: "live",
        },
        issues: [
          { id: "demo-8v0", board_id: "demo", title: "P1 settings card", status: "in_progress" },
          { id: "demo-qmk", board_id: "demo", title: "P2 bridge", status: "in_progress" },
        ],
        runtime_sessions: [
          {
            session_id: "s1",
            runtime_id: "p3",
            last_seen: 1_788_551_950_000,
            main: { thread: "t1" },
            subagents: [{ id: "a" }, { id: "b" }, { id: "c" }],
          },
          { session_id: "s2", runtime_id: "phi", last_seen: 0, main: null, subagents: 4 },
        ],
        experimental_field: { nested: true },
      },
      {
        actor: "bob-phi",
        display_name: "bob-phi",
        kind: "agent",
        registered: true,
        item_count: 1,
        latest_activity: 1_788_551_000_000,
        last_seen: 1_788_551_000_000,
        flare: null,
        issues: [{ id: "demo-2qt", board_id: "demo", title: "gateway fallback", status: "open" }],
        runtime_sessions: [],
      },
      {
        actor: "idle-bot",
        display_name: "Idle Bot",
        kind: "robot",
        registered: true,
        item_count: 0,
        latest_activity: null,
        last_seen: null,
        flare: null,
        issues: [],
        runtime_sessions: [],
      },
    ],
    discussions: [
      {
        id: "demo-dis",
        board_id: "demo",
        title: "Where should the token live?",
        status: "open",
        participants: [
          {
            actor: "alice-agent",
            comment_count: 3,
            last_commented_at: 1_788_551_000_000,
          },
          { actor: "bob-phi", comment_count: 1, last_commented_at: 1_788_551_900_000 },
        ],
        latest_comment: { text: "secret store", actor: "bob-phi" },
      },
    ],
  },
  server_time: 1_788_552_000_500,
};

export const ISSUES_FIXTURE = {
  ok: true,
  actor: "alice-agent",
  issues: [
    {
      id: "demo-8v0",
      title: "P1 settings card",
      status: "in_progress",
      issue_type: "task",
      priority: 2,
      assignee: "alice-agent",
      labels: ["p3code"],
      board_id: "demo",
      board_name: "Demo",
      created_at: "2026-09-04T18:00:00.000Z",
      updated_at: 1_788_551_900_000,
      closed_at: null,
      blocked_by: ["demo-uzx", { id: "demo-0gn" }],
    },
    { id: "demo-abc", title: "bare bead" },
  ],
};

/** Synthetic notification examples; never a live board response. */
export const NOTIFICATIONS_FIXTURE = {
  ok: true,
  actor: "alice-agent",
  notifications: [
    {
      id: "n_demo_one",
      board_id: "demo",
      recipient_actor: "alice-agent",
      type: "update_on_commented",
      issue_id: "demo-abc",
      issue_title: "Update example documentation",
      actor: "",
      snippet: "Status: in_progress → closed",
      related_issue: "",
      created_at: 1_788_552_025_009,
      read_at: 0,
      handled_at: 0,
      url: "#/issues?issue=demo-abc",
    },
    {
      id: "n_mention",
      board_id: "demo",
      recipient_actor: "alice-agent",
      type: "mention",
      issue_id: "demo-px1",
      issue_title: "P5 connectors catalog",
      actor: "bob-phi",
      snippet: "@alice-agent which URL?",
      related_issue: "demo-8v0",
      created_at: 1_788_552_100_000,
      read_at: 0,
      handled_at: 0,
      url: "#/issues?issue=demo-px1",
    },
    { id: "n_weird", type: "something_new" },
  ],
  unread_count: 98,
  unhandled_count: 98,
};
