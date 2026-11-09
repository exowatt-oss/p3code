/**
 * feads wire format → P3 contract shapes. The poller's doors (`/api/agentwatch`,
 * `/api/issues`, `/api/notifications`) are decoded with loose schemas: fields optional,
 * unknown fields ignored. A 404 is a door feads has not opened yet and becomes `missing`.
 *
 * @module FeadsWire
 */
import type {
  ExowattFeadsActorKind,
  ExowattFeadsAgentwatchData,
  ExowattFeadsAgentwatchAgent,
  ExowattFeadsAgentwatchDiscussion,
  ExowattFeadsAckResult,
  ExowattFeadsIssue,
  ExowattFeadsNotification,
  ExowattFeadsNotificationType,
  ExowattFeadsRuntimeSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { FeadsBeadComment, FeadsBeadDetail } from "./FeadsBeadBrief.ts";

export type FeedOutcome<T> =
  | { readonly kind: "ok"; readonly actor: string | null; readonly data: T }
  /** 404: the route does not exist on this feads yet. */
  | { readonly kind: "missing" }
  | { readonly kind: "unauthorized"; readonly error: string }
  | { readonly kind: "error"; readonly error: string };

const opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullishOr(schema));

const WireTime = Schema.Union([Schema.Number, Schema.String]);
const WireStringList = Schema.Array(
  Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })]),
);

const WireEnvelope = Schema.Struct({
  ok: opt(Schema.Boolean),
  actor: opt(Schema.String),
  error: opt(Schema.String),
});

const WireHeldIssue = Schema.Struct({
  id: Schema.String,
  board_id: opt(Schema.String),
  title: opt(Schema.String),
  status: opt(Schema.String),
});

const WireRuntimeSession = Schema.Struct({
  session_id: opt(Schema.String),
  runtime_id: opt(Schema.String),
  last_seen: opt(WireTime),
  main: opt(Schema.Unknown),
  subagents: opt(Schema.Unknown),
});

/** A presence flare: the bead an agent says it is on right now. */
const WireFlare = Schema.Struct({
  board_id: opt(Schema.String),
  issue_id: opt(Schema.String),
});

const WireAgent = Schema.Struct({
  actor: Schema.String,
  display_name: opt(Schema.String),
  kind: opt(Schema.String),
  registered: opt(Schema.Boolean),
  item_count: opt(Schema.Number),
  latest_activity: opt(WireTime),
  last_seen: opt(WireTime),
  flare: opt(WireFlare),
  issues: opt(Schema.Array(WireHeldIssue)),
  runtime_sessions: opt(Schema.Array(WireRuntimeSession)),
});

const WireDiscussion = Schema.Struct({
  id: Schema.String,
  board_id: opt(Schema.String),
  title: opt(Schema.String),
  status: opt(Schema.String),
  participants: opt(Schema.Array(Schema.Struct({ actor: Schema.String }))),
  latest_comment: opt(Schema.Unknown),
});

const WireAgentwatch = Schema.Struct({
  ...WireEnvelope.fields,
  snapshot: opt(
    Schema.Struct({
      generated_at: opt(WireTime),
      stats: opt(
        Schema.Struct({
          active_agents: opt(Schema.Number),
          registered_agents: opt(Schema.Number),
          active_issues: opt(Schema.Number),
          shared_discussions: opt(Schema.Number),
        }),
      ),
      agents: opt(Schema.Array(WireAgent)),
      discussions: opt(Schema.Array(WireDiscussion)),
    }),
  ),
});

const WireIssue = Schema.Struct({
  id: Schema.String,
  title: opt(Schema.String),
  status: opt(Schema.String),
  issue_type: opt(Schema.String),
  priority: opt(Schema.Number),
  assignee: opt(Schema.String),
  labels: opt(Schema.Array(Schema.String)),
  board_id: opt(Schema.String),
  board_name: opt(Schema.String),
  created_at: opt(WireTime),
  updated_at: opt(WireTime),
  closed_at: opt(WireTime),
  blocked_by: opt(WireStringList),
});

const WireIssues = Schema.Struct({
  ...WireEnvelope.fields,
  issues: opt(Schema.Array(WireIssue)),
});

const WireNotification = Schema.Struct({
  id: Schema.String,
  board_id: opt(Schema.String),
  recipient_actor: opt(Schema.String),
  type: opt(Schema.String),
  issue_id: opt(Schema.String),
  issue_title: opt(Schema.String),
  actor: opt(Schema.String),
  snippet: opt(Schema.String),
  related_issue: opt(Schema.String),
  created_at: opt(WireTime),
  read_at: opt(WireTime),
  handled_at: opt(WireTime),
  url: opt(Schema.String),
});

const WireNotifications = Schema.Struct({
  ...WireEnvelope.fields,
  notifications: opt(Schema.Array(WireNotification)),
  unread_count: opt(Schema.Number),
  unhandled_count: opt(Schema.Number),
});

const WireComment = Schema.Struct({
  author: opt(Schema.String),
  actor: opt(Schema.String),
  text: opt(Schema.String),
  body: opt(Schema.String),
  created_at: opt(WireTime),
});

/** What the MCP `comments` tool returns: the list itself, or one wrapping it. */
const WireCommentList = Schema.Array(WireComment);
const WireCommentEnvelope = Schema.Struct({ comments: opt(WireCommentList) });

/**
 * What the MCP `show` tool returns: an issue row plus the long-form fields the
 * board listing does not carry. Same snake_case names as `/api/issues`, so the
 * row half is decoded by the same mapper.
 */
const WireBead = Schema.Struct({
  ...WireIssue.fields,
  description: opt(Schema.String),
  acceptance_criteria: opt(Schema.String),
  design: opt(Schema.String),
});

const WireAck = Schema.Struct({
  ...WireEnvelope.fields,
  acknowledged: opt(Schema.Number),
  count: opt(Schema.Number),
  updated: opt(Schema.Number),
  acked: opt(Schema.Number),
});

const decodeEnvelope = Schema.decodeUnknownOption(WireEnvelope);
const decodeAgentwatchWire = Schema.decodeUnknownOption(WireAgentwatch);
const decodeIssuesWire = Schema.decodeUnknownOption(WireIssues);
const decodeNotificationsWire = Schema.decodeUnknownOption(WireNotifications);
const decodeAckWire = Schema.decodeUnknownOption(WireAck);
const decodeBeadWire = Schema.decodeUnknownOption(WireBead);
const decodeCommentListWire = Schema.decodeUnknownOption(WireCommentList);
const decodeCommentEnvelopeWire = Schema.decodeUnknownOption(WireCommentEnvelope);

type Nullish<T> = T | null | undefined;

const str = (value: Nullish<string>): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
const num = (value: Nullish<number>): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** feads uses 0 for "never" on timestamps; both ms and ISO strings occur. */
export function wireTimeToMs(value: Nullish<number | string>): number | null {
  if (typeof value === "number") return value > 0 && Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = DateTime.make(value.trim());
    return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
  }
  return null;
}

export function wireTimeToIso(value: Nullish<number | string>): string | null {
  const ms = wireTimeToMs(value);
  if (ms === null) return null;
  const parsed = DateTime.make(ms);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null;
}

function actorKind(value: Nullish<string>): ExowattFeadsActorKind {
  return value === "human" || value === "agent" ? value : "unknown";
}

function notificationType(value: Nullish<string>): ExowattFeadsNotificationType {
  switch (value) {
    case "mention":
    case "assigned":
    case "comment_on_owned":
    case "update_on_commented":
    case "dependency_completed":
      return value;
    default:
      return "other";
  }
}

/** `subagents` is either the list itself or already a count; anything else is 0. */
export function subagentCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return 0;
}

function latestCommentText(value: unknown): string | null {
  if (typeof value === "string") return str(value);
  if (typeof value === "object" && value !== null) {
    const record = value as { readonly text?: unknown; readonly body?: unknown };
    if (typeof record.text === "string") return str(record.text);
    if (typeof record.body === "string") return str(record.body);
  }
  return null;
}

/**
 * Shared status handling. Returns an outcome for anything that is not a
 * decodable 2xx, or `null` when the caller should go on and decode the body.
 */
function classify(status: number, json: unknown): FeedOutcome<never> | null {
  if (status === 404) return { kind: "missing" };
  if (status === 401 || status === 403) {
    const envelope = decodeEnvelope(json);
    const error = Option.isSome(envelope) ? str(envelope.value.error) : null;
    return { kind: "unauthorized", error: error ?? "not_identified" };
  }
  if (status < 200 || status >= 300) return { kind: "error", error: `http_${status}` };
  if (json === null || json === undefined) return { kind: "error", error: "not_json" };
  const envelope = decodeEnvelope(json);
  if (Option.isSome(envelope) && envelope.value.ok === false) {
    return { kind: "error", error: str(envelope.value.error) ?? "not_ok" };
  }
  return null;
}

function mapRuntimeSession(
  session: typeof WireRuntimeSession.Type,
  index: number,
): ExowattFeadsRuntimeSession {
  return {
    sessionId: str(session.session_id) ?? `session-${index}`,
    runtimeId: str(session.runtime_id) ?? "",
    lastSeen: wireTimeToMs(session.last_seen),
    subagentCount: subagentCount(session.subagents),
  };
}

function mapAgent(agent: typeof WireAgent.Type): ExowattFeadsAgentwatchAgent {
  return {
    actor: agent.actor,
    displayName: str(agent.display_name) ?? agent.actor,
    kind: actorKind(agent.kind),
    registered: agent.registered === true,
    itemCount: num(agent.item_count) ?? 0,
    latestActivity: wireTimeToMs(agent.latest_activity),
    lastSeen: wireTimeToMs(agent.last_seen),
    flare: str(agent.flare?.issue_id),
    issues: (agent.issues ?? []).map((issue) => ({
      id: issue.id,
      boardId: str(issue.board_id) ?? "",
      title: str(issue.title) ?? issue.id,
      status: str(issue.status) ?? "",
    })),
    runtimeSessions: (agent.runtime_sessions ?? []).map(mapRuntimeSession),
  };
}

function mapDiscussion(discussion: typeof WireDiscussion.Type): ExowattFeadsAgentwatchDiscussion {
  return {
    id: discussion.id,
    boardId: str(discussion.board_id) ?? "",
    title: str(discussion.title) ?? discussion.id,
    status: str(discussion.status) ?? "",
    participants: (discussion.participants ?? []).map((participant) => participant.actor),
    latestComment: latestCommentText(discussion.latest_comment),
  };
}

export function decodeAgentwatch(
  status: number,
  json: unknown,
): FeedOutcome<ExowattFeadsAgentwatchData> {
  const early = classify(status, json);
  if (early) return early;
  const wire = decodeAgentwatchWire(json);
  if (Option.isNone(wire)) return { kind: "error", error: "unexpected_shape" };
  const snapshot = wire.value.snapshot ?? undefined;
  const stats = snapshot?.stats ?? undefined;
  const agents = (snapshot?.agents ?? []).map(mapAgent);
  return {
    kind: "ok",
    actor: str(wire.value.actor),
    data: {
      generatedAt: wireTimeToMs(snapshot?.generated_at),
      stats: {
        activeAgents:
          num(stats?.active_agents) ?? agents.filter((agent) => agent.itemCount > 0).length,
        registeredAgents:
          num(stats?.registered_agents) ?? agents.filter((agent) => agent.registered).length,
        activeIssues:
          num(stats?.active_issues) ??
          agents.reduce((total, agent) => total + agent.issues.length, 0),
        sharedDiscussions: num(stats?.shared_discussions) ?? (snapshot?.discussions ?? []).length,
      },
      agents,
      discussions: (snapshot?.discussions ?? []).map(mapDiscussion),
    },
  };
}

function mapIssue(issue: typeof WireIssue.Type): ExowattFeadsIssue {
  return {
    id: issue.id,
    title: str(issue.title) ?? issue.id,
    status: str(issue.status) ?? "",
    issueType: str(issue.issue_type),
    priority: num(issue.priority),
    assignee: str(issue.assignee),
    labels: issue.labels ?? [],
    boardId: str(issue.board_id),
    boardName: str(issue.board_name),
    createdAt: wireTimeToIso(issue.created_at),
    updatedAt: wireTimeToIso(issue.updated_at),
    closedAt: wireTimeToIso(issue.closed_at),
    blockedBy: (issue.blocked_by ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.id,
    ),
  };
}

export function decodeIssues(
  status: number,
  json: unknown,
): FeedOutcome<ReadonlyArray<ExowattFeadsIssue>> {
  const early = classify(status, json);
  if (early) return early;
  const wire = decodeIssuesWire(json);
  if (Option.isNone(wire)) return { kind: "error", error: "unexpected_shape" };
  return {
    kind: "ok",
    actor: str(wire.value.actor),
    data: (wire.value.issues ?? []).map(mapIssue),
  };
}

function mapNotification(row: typeof WireNotification.Type): ExowattFeadsNotification {
  return {
    id: row.id,
    boardId: str(row.board_id),
    type: notificationType(row.type),
    issueId: str(row.issue_id),
    issueTitle: str(row.issue_title),
    actor: str(row.actor),
    snippet: str(row.snippet),
    relatedIssue: str(row.related_issue),
    createdAt: wireTimeToIso(row.created_at),
    readAt: wireTimeToIso(row.read_at),
    handledAt: wireTimeToIso(row.handled_at),
    url: str(row.url),
  };
}

export interface DecodedInbox {
  readonly notifications: ReadonlyArray<ExowattFeadsNotification>;
  readonly unreadCount: number;
}

export function decodeNotifications(status: number, json: unknown): FeedOutcome<DecodedInbox> {
  const early = classify(status, json);
  if (early) return early;
  const wire = decodeNotificationsWire(json);
  if (Option.isNone(wire)) return { kind: "error", error: "unexpected_shape" };
  const notifications = (wire.value.notifications ?? []).map(mapNotification);
  return {
    kind: "ok",
    actor: str(wire.value.actor),
    data: {
      notifications,
      unreadCount: num(wire.value.unread_count) ?? notifications.length,
    },
  };
}

export function decodeAck(status: number, json: unknown): FeedOutcome<ExowattFeadsAckResult> {
  const early = classify(status, json);
  if (early) return early;
  const wire = decodeAckWire(json);
  if (Option.isNone(wire)) return { kind: "error", error: "unexpected_shape" };
  const count =
    num(wire.value.acknowledged) ??
    num(wire.value.count) ??
    num(wire.value.updated) ??
    num(wire.value.acked);
  return { kind: "ok", actor: str(wire.value.actor), data: { ok: true, count } };
}

function mapComment(row: typeof WireComment.Type): FeadsBeadComment {
  return {
    author: str(row.author) ?? str(row.actor),
    text: str(row.text) ?? str(row.body) ?? "",
    createdAt: wireTimeToIso(row.created_at),
  };
}

export interface DecodedBead {
  /** The same shape the listing produces, so the brief has one fact source. */
  readonly issue: ExowattFeadsIssue;
  readonly detail: FeadsBeadDetail;
}

/**
 * The MCP `show` payload. `null` when it is not a bead — the caller then falls
 * back to whatever the poller knows, rather than failing the thread.
 */
export function decodeBeadShow(json: unknown): DecodedBead | null {
  const wire = decodeBeadWire(json);
  if (Option.isNone(wire)) return null;
  return {
    issue: mapIssue(wire.value),
    detail: {
      description: str(wire.value.description),
      acceptanceCriteria: str(wire.value.acceptance_criteria),
      design: str(wire.value.design),
    },
  };
}

/** The MCP `comments` payload, oldest first as feads returns it. */
export function decodeBeadComments(json: unknown): ReadonlyArray<FeadsBeadComment> {
  const list = decodeCommentListWire(json);
  const envelope = Option.isSome(list) ? Option.none() : decodeCommentEnvelopeWire(json);
  const rows: ReadonlyArray<typeof WireComment.Type> = Option.isSome(list)
    ? list.value
    : Option.isSome(envelope)
      ? (envelope.value.comments ?? [])
      : [];
  return rows.map(mapComment).filter((comment) => comment.text.length > 0);
}

export const FEADS_AGENTWATCH_PATH = "/api/agentwatch";
export const FEADS_MY_ISSUES_PATH = "/api/issues?status=in_progress&assignee=me&board=*";
export const FEADS_INBOX_PATH = "/api/notifications?unread_only=1&limit=50";
export const FEADS_ACK_PATH = "/api/notifications/ack";
/** `PUT` a batch of rows, `DELETE` one runtime; see FeadsPresencePublisher. */
export const FEADS_PRESENCE_PATH = "/api/runtime-presence";
