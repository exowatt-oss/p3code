// Exowatt distro: the feads integration (Settings › Sharing & access › feads and
// the /agents Agentwatch + My board panels). The bearer token lives in the
// server's secret store and never crosses the wire; every schema here is
// what the web client is allowed to see.
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const EXOWATT_FEADS_DEFAULT_BASE_URL = "http://127.0.0.1:3000";

/**
 * Where the token in force came from. `environment` means `P3_FEADS_TOKEN`
 * is set on the server process, which wins over anything saved from Settings
 * and cannot be edited or cleared from the client.
 */
export const ExowattFeadsTokenSource = Schema.Literals(["none", "settings", "environment"]);
export type ExowattFeadsTokenSource = typeof ExowattFeadsTokenSource.Type;

/**
 * The server's own Agentwatch presence for threads on engines other than Phi
 * (Phi publishes its own rows). `kill_switch` means `P3_FEADS_PRESENCE=0` is
 * set on the server.
 */
export const ExowattFeadsPresenceStatus = Schema.Struct({
  enabled: Schema.Boolean,
  disabledReason: Schema.NullOr(Schema.Literals(["kill_switch", "not_configured"])),
  /** Provider sessions feads currently holds a row for. */
  liveRows: NonNegativeInt,
  /** ISO timestamp of the last request feads accepted. */
  lastPublishedAt: Schema.NullOr(Schema.String),
  /** Failure category of the last cycle (`http_401`, `network`, ...); null when healthy. */
  lastError: Schema.NullOr(Schema.String),
});
export type ExowattFeadsPresenceStatus = typeof ExowattFeadsPresenceStatus.Type;

export const ExowattFeadsStatus = Schema.Struct({
  configured: Schema.Boolean,
  baseUrl: Schema.String,
  /** Actor the token resolved to on the last successful identity check or poll. */
  actor: Schema.NullOr(Schema.String),
  defaultBoard: Schema.NullOr(Schema.String),
  /** ISO timestamp of the last poll that reached feads (success or refusal). */
  lastPollAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  tokenSource: ExowattFeadsTokenSource,
  /** Absent until the presence publisher has started (and from older servers). */
  presence: Schema.optionalKey(ExowattFeadsPresenceStatus),
});
export type ExowattFeadsStatus = typeof ExowattFeadsStatus.Type;

export const ExowattFeadsConfigureInput = Schema.Struct({
  /** Write-only. Omit to keep the stored token; the empty string is refused. */
  token: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  /** `null` or an empty string clears the default board. */
  defaultBoard: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ExowattFeadsConfigureInput = typeof ExowattFeadsConfigureInput.Type;

export const ExowattFeadsTestResult = Schema.Struct({
  ok: Schema.Boolean,
  actor: Schema.NullOr(Schema.String),
  /** Stable code (`not_configured`, `not_identified`, `http_503`, `network`) or a message. */
  error: Schema.NullOr(Schema.String),
});
export type ExowattFeadsTestResult = typeof ExowattFeadsTestResult.Type;

export class ExowattFeadsError extends Schema.TaggedError<ExowattFeadsError>()(
  "ExowattFeadsError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `feads ${this.operation} failed: ${this.reason}`;
  }
}

/** Dashboard deep link for a bead; opened in the system browser, never in-app. */
export function exowattFeadsIssueUrl(baseUrl: string, issueId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/#/issues?issue=${encodeURIComponent(issueId)}`;
}

// Feeds the server poller republishes (P2). These are P3's own shapes: the
// server decodes feads' snake_case wire format tolerantly and maps it here, so
// the web app never depends on fields feads may rename.

/**
 * Common envelope. `available: false` means feads answered 404 for the route
 * (the door is not open for agents yet); `error` is the last fetch failure
 * while `data`/rows keep the last good result so the panels do not flash.
 */
const feedEnvelope = {
  available: Schema.Boolean,
  /** ISO time of the last successful fetch; null before the first. */
  fetchedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  actor: Schema.NullOr(Schema.String),
};

export const ExowattFeadsActorKind = Schema.Literals(["human", "agent", "unknown"]);
export type ExowattFeadsActorKind = typeof ExowattFeadsActorKind.Type;

export const ExowattFeadsHeldIssue = Schema.Struct({
  id: Schema.String,
  boardId: Schema.String,
  title: Schema.String,
  status: Schema.String,
});
export type ExowattFeadsHeldIssue = typeof ExowattFeadsHeldIssue.Type;

export const ExowattFeadsRuntimeSession = Schema.Struct({
  sessionId: Schema.String,
  runtimeId: Schema.String,
  /** Epoch milliseconds. */
  lastSeen: Schema.NullOr(Schema.Number),
  subagentCount: Schema.Number,
});
export type ExowattFeadsRuntimeSession = typeof ExowattFeadsRuntimeSession.Type;

export const ExowattFeadsAgentwatchAgent = Schema.Struct({
  actor: Schema.String,
  displayName: Schema.String,
  kind: ExowattFeadsActorKind,
  registered: Schema.Boolean,
  itemCount: Schema.Number,
  /** Epoch milliseconds. */
  latestActivity: Schema.NullOr(Schema.Number),
  lastSeen: Schema.NullOr(Schema.Number),
  flare: Schema.NullOr(Schema.String),
  issues: Schema.Array(ExowattFeadsHeldIssue),
  runtimeSessions: Schema.Array(ExowattFeadsRuntimeSession),
});
export type ExowattFeadsAgentwatchAgent = typeof ExowattFeadsAgentwatchAgent.Type;

export const ExowattFeadsAgentwatchDiscussion = Schema.Struct({
  id: Schema.String,
  boardId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  participants: Schema.Array(Schema.String),
  latestComment: Schema.NullOr(Schema.String),
});
export type ExowattFeadsAgentwatchDiscussion = typeof ExowattFeadsAgentwatchDiscussion.Type;

export const ExowattFeadsAgentwatchStats = Schema.Struct({
  activeAgents: Schema.Number,
  registeredAgents: Schema.Number,
  activeIssues: Schema.Number,
  sharedDiscussions: Schema.Number,
});
export type ExowattFeadsAgentwatchStats = typeof ExowattFeadsAgentwatchStats.Type;

export const ExowattFeadsAgentwatchData = Schema.Struct({
  /** Epoch milliseconds feads generated the snapshot at. */
  generatedAt: Schema.NullOr(Schema.Number),
  stats: ExowattFeadsAgentwatchStats,
  agents: Schema.Array(ExowattFeadsAgentwatchAgent),
  discussions: Schema.Array(ExowattFeadsAgentwatchDiscussion),
});
export type ExowattFeadsAgentwatchData = typeof ExowattFeadsAgentwatchData.Type;

export const ExowattFeadsAgentwatchSnapshot = Schema.Struct({
  ...feedEnvelope,
  data: Schema.NullOr(ExowattFeadsAgentwatchData),
});
export type ExowattFeadsAgentwatchSnapshot = typeof ExowattFeadsAgentwatchSnapshot.Type;

export const ExowattFeadsIssue = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  issueType: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Number),
  assignee: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  boardId: Schema.NullOr(Schema.String),
  boardName: Schema.NullOr(Schema.String),
  /** ISO timestamps (feads sends ms or ISO; the server normalises). */
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(Schema.String),
  blockedBy: Schema.Array(Schema.String),
});
export type ExowattFeadsIssue = typeof ExowattFeadsIssue.Type;

export const ExowattFeadsMyIssuesSnapshot = Schema.Struct({
  ...feedEnvelope,
  issues: Schema.Array(ExowattFeadsIssue),
});
export type ExowattFeadsMyIssuesSnapshot = typeof ExowattFeadsMyIssuesSnapshot.Type;

export const ExowattFeadsNotificationType = Schema.Literals([
  "mention",
  "assigned",
  "comment_on_owned",
  "update_on_commented",
  "dependency_completed",
  "other",
]);
export type ExowattFeadsNotificationType = typeof ExowattFeadsNotificationType.Type;

export const ExowattFeadsNotification = Schema.Struct({
  id: Schema.String,
  boardId: Schema.NullOr(Schema.String),
  type: ExowattFeadsNotificationType,
  issueId: Schema.NullOr(Schema.String),
  issueTitle: Schema.NullOr(Schema.String),
  /** Who caused it; empty on system-generated rows. */
  actor: Schema.NullOr(Schema.String),
  snippet: Schema.NullOr(Schema.String),
  relatedIssue: Schema.NullOr(Schema.String),
  /** ISO timestamps. */
  createdAt: Schema.NullOr(Schema.String),
  readAt: Schema.NullOr(Schema.String),
  handledAt: Schema.NullOr(Schema.String),
  /** Dashboard fragment such as `#/issues?issue=demo-abc`, relative to the base URL. */
  url: Schema.NullOr(Schema.String),
});
export type ExowattFeadsNotification = typeof ExowattFeadsNotification.Type;

export const ExowattFeadsInboxSnapshot = Schema.Struct({
  ...feedEnvelope,
  notifications: Schema.Array(ExowattFeadsNotification),
  unreadCount: Schema.Number,
});
export type ExowattFeadsInboxSnapshot = typeof ExowattFeadsInboxSnapshot.Type;

export const ExowattFeadsAckInput = Schema.Struct({
  ids: Schema.optionalKey(Schema.Array(Schema.String)),
  all: Schema.optionalKey(Schema.Boolean),
});
export type ExowattFeadsAckInput = typeof ExowattFeadsAckInput.Type;

export const ExowattFeadsAckResult = Schema.Struct({
  ok: Schema.Boolean,
  /** How many feads says it acknowledged, when it says. */
  count: Schema.NullOr(Schema.Number),
});
export type ExowattFeadsAckResult = typeof ExowattFeadsAckResult.Type;

// Open as P3 thread: a bead becomes a thread whose first message is the brief
// the server built for it. The client picks the bead and the project; the brief
// itself is never assembled client-side, so an MCP tool can reuse the builder.

export const ExowattFeadsOpenThreadInput = Schema.Struct({
  issueId: Schema.String,
  projectId: ProjectId,
  /** Defaults to the project's model, then the server's. */
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type ExowattFeadsOpenThreadInput = typeof ExowattFeadsOpenThreadInput.Type;

export const ExowattFeadsOpenThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  /** Whether the "opened as a P3 thread" comment reached the bead. */
  commentPosted: Schema.Boolean,
  /** Why it did not, in feads' own words. Null when the comment landed. */
  commentError: Schema.NullOr(Schema.String),
});
export type ExowattFeadsOpenThreadResult = typeof ExowattFeadsOpenThreadResult.Type;
