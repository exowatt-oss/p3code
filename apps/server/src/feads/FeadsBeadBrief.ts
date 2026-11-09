/**
 * The brief a bead becomes when it is opened as a P3 thread. Pure on purpose: built from
 * whatever the server knows about the bead (everything except the id is optional), so a
 * half-read bead still produces a usable brief and an MCP tool can reuse the builder.
 *
 * @module FeadsBeadBrief
 */
import {
  type ExowattFeadsIssue,
  type ExowattFeadsNotification,
  exowattFeadsIssueUrl,
} from "@t3tools/contracts";

/** How many of the most recent comments the brief carries. */
export const FEADS_BRIEF_MAX_COMMENTS = 10;
/** A brief is a prompt, not an archive: one comment is cut at this length. */
export const FEADS_BRIEF_MAX_COMMENT_CHARS = 1_000;
const MAX_TITLE_LENGTH = 80;

export interface FeadsBeadComment {
  readonly author: string | null;
  readonly text: string;
  /** ISO timestamp when feads sends one. */
  readonly createdAt?: string | null;
}

/**
 * The long-form fields of a bead. Absent until feads opens a door that returns
 * them; the brief then tells the agent to read the bead itself.
 */
export interface FeadsBeadDetail {
  readonly description?: string | null;
  readonly acceptanceCriteria?: string | null;
  readonly design?: string | null;
  readonly comments?: ReadonlyArray<FeadsBeadComment>;
}

export interface FeadsBeadBriefInput {
  readonly issueId: string;
  readonly baseUrl: string;
  /** The `/api/issues` row, when the poller has one for this bead. */
  readonly issue?: ExowattFeadsIssue | null;
  /** An inbox row mentioning the bead, used when there is no issue row. */
  readonly notification?: ExowattFeadsNotification | null;
  readonly detail?: FeadsBeadDetail | null;
}

export interface FeadsBeadBrief {
  /** Thread title: `<id> <title>`, cut to a sane length. */
  readonly title: string;
  /** The first user message. */
  readonly text: string;
}

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `title` when feads knows one, else the bead id so the thread is never nameless. */
export function feadsBeadTitle(input: FeadsBeadBriefInput): string {
  const title = trimmed(input.issue?.title) ?? trimmed(input.notification?.issueTitle);
  return truncate(title === null ? input.issueId : `${input.issueId} ${title}`, MAX_TITLE_LENGTH);
}

/** `type · priority 2 · in_progress · board forca` — only the parts feads sent. */
function facts(issue: ExowattFeadsIssue | null | undefined): ReadonlyArray<string> {
  if (!issue) return [];
  return [
    trimmed(issue.issueType),
    issue.priority === null ? null : `priority ${issue.priority}`,
    trimmed(issue.status),
    trimmed(issue.assignee) === null ? null : `assigned to ${issue.assignee}`,
    trimmed(issue.boardName) ?? trimmed(issue.boardId),
    issue.blockedBy.length === 0 ? null : `blocked by ${issue.blockedBy.join(", ")}`,
  ].filter((entry): entry is string => entry !== null);
}

function section(heading: string, body: string | null): string | null {
  return body === null ? null : `## ${heading}\n\n${body}`;
}

function renderComments(comments: ReadonlyArray<FeadsBeadComment>): string | null {
  const recent = comments.slice(-FEADS_BRIEF_MAX_COMMENTS);
  const rendered = recent
    .map((comment) => {
      const text = trimmed(comment.text);
      if (text === null) return null;
      const author = trimmed(comment.author) ?? "unknown";
      return `- **${author}**: ${truncate(text, FEADS_BRIEF_MAX_COMMENT_CHARS)}`;
    })
    .filter((entry): entry is string => entry !== null);
  if (rendered.length === 0) return null;
  const omitted = comments.length - recent.length;
  return omitted > 0
    ? `${rendered.join("\n")}\n\n(${omitted} older comment${omitted === 1 ? "" : "s"} not shown; read the bead for the rest.)`
    : rendered.join("\n");
}

/**
 * Build the brief. Self-contained by design: an agent that never reaches feads
 * can still start, and one that can is told where the bead lives and what to
 * write back to it.
 */
export function buildFeadsBeadBrief(input: FeadsBeadBriefInput): FeadsBeadBrief {
  const url = exowattFeadsIssueUrl(input.baseUrl, input.issueId);
  const title = trimmed(input.issue?.title) ?? trimmed(input.notification?.issueTitle);
  const factLine = facts(input.issue);
  const labels = input.issue?.labels.filter((label) => label.trim().length > 0) ?? [];
  const detail = input.detail ?? null;
  const comments = detail?.comments ?? [];
  const hasDetail =
    trimmed(detail?.description) !== null ||
    trimmed(detail?.acceptanceCriteria) !== null ||
    trimmed(detail?.design) !== null ||
    comments.length > 0;
  const parts: ReadonlyArray<string | null> = [
    `# ${input.issueId}${title === null ? "" : `: ${title}`}`,
    "You are picking up a feads work item. Everything known about it follows.",
    factLine.length === 0 ? null : `**Bead:** ${factLine.join(" · ")}`,
    labels.length === 0 ? null : `**Labels:** ${labels.join(", ")}`,
    `**Dashboard:** ${url}`,
    section("Description", trimmed(detail?.description)),
    section("Acceptance criteria", trimmed(detail?.acceptanceCriteria)),
    section("Design", trimmed(detail?.design)),
    section("Recent comments", renderComments(comments)),
    trimmed(input.notification?.snippet) === null
      ? null
      : section("Why this reached me", `${trimmed(input.notification?.snippet)}`),
    hasDetail
      ? null
      : // The poller's row carries no long-form fields, so the agent has to go
        // and read them; saying so beats a brief that pretends to be complete.
        "This brief carries only what the board listing exposes: reading the bead " +
        "itself failed or returned nothing. Read it before you start: the dashboard " +
        "link above, or `show`/`comments` on the feads MCP server.",
    "Work this item; keep its feads state honest (in_progress now, close when it lands) " +
      "and comment the outcome on the bead.",
  ];
  return {
    title: feadsBeadTitle(input),
    text: parts.filter((part): part is string => part !== null).join("\n\n"),
  };
}
