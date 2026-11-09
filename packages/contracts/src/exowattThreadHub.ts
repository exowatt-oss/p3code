// Exowatt distro: the thread Hub's per-thread overlay. The client derives outputs and sources from
// turn items (`apps/web/src/lib/hubArtifacts.ts`); pins, hides and hand-added links, paths and
// notes live here so they survive restarts and sync. One entry per (thread, kind, key); `kind`
// and `key` are the client's own item identity, stored uninterpreted.
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Every Hub item kind. The output and source kinds are what the client derives;
 * `note-output` and `note-source` only exist as manual entries.
 */
export const ExowattThreadHubItemKind = Schema.Literals([
  // Outputs
  "file-output",
  "pull-request",
  "commit",
  "link-output",
  "preview",
  "attachment",
  "note-output",
  // Sources
  "file-read",
  "url-fetch",
  "web-search",
  "mcp-tool",
  "skill",
  "note-source",
]);
export type ExowattThreadHubItemKind = typeof ExowattThreadHubItemKind.Type;

/** Paths, URLs and notes are user text; cap them so one entry cannot bloat every snapshot. */
const MAX_KEY_CHARS = 4096;
const MAX_TITLE_CHARS = 200;
const MAX_NOTE_CHARS = 4000;

const ItemKey = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_KEY_CHARS)).annotate({
  description:
    "The item's identity within its kind: a normalized path for files, the URL for links and pages, `host/repo#n` for pull requests, the sha for commits, `server/tool` for MCP tools, `search:<query>` for searches, a generated id for notes.",
});

/** What a hand-added entry shows. Present only on manual entries. */
export const ExowattThreadHubManual = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_TITLE_CHARS)),
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_KEY_CHARS))),
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_KEY_CHARS))),
  note: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_NOTE_CHARS))),
});
export type ExowattThreadHubManual = typeof ExowattThreadHubManual.Type;

const ExowattThreadHubItemRef = Schema.Struct({
  threadId: ThreadId,
  kind: ExowattThreadHubItemKind,
  key: ItemKey,
});

export const ExowattThreadHubEntry = Schema.Struct({
  ...ExowattThreadHubItemRef.fields,
  pinned: Schema.Boolean,
  hidden: Schema.Boolean,
  /** Null for an overlay on a derived item. */
  manual: Schema.NullOr(ExowattThreadHubManual),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExowattThreadHubEntry = typeof ExowattThreadHubEntry.Type;

export const ExowattThreadHubGetInput = Schema.Struct({ threadId: ThreadId });
export type ExowattThreadHubGetInput = typeof ExowattThreadHubGetInput.Type;

/** Every entry for one thread, oldest first. */
export const ExowattThreadHubSnapshot = Schema.Struct({
  threadId: ThreadId,
  entries: Schema.Array(ExowattThreadHubEntry),
});
export type ExowattThreadHubSnapshot = typeof ExowattThreadHubSnapshot.Type;

/**
 * Patch one entry. Omitted fields keep their stored value. An overlay on a
 * derived item that ends up neither pinned nor hidden is deleted: absent is
 * the resting state, so the table only holds what the user did.
 */
export const ExowattThreadHubUpsertInput = Schema.Struct({
  ...ExowattThreadHubItemRef.fields,
  pinned: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  manual: Schema.optional(ExowattThreadHubManual),
});
export type ExowattThreadHubUpsertInput = typeof ExowattThreadHubUpsertInput.Type;

export const ExowattThreadHubUpsertResult = Schema.Struct({
  /** Null when the patch returned the item to its resting state. */
  entry: Schema.NullOr(ExowattThreadHubEntry),
});
export type ExowattThreadHubUpsertResult = typeof ExowattThreadHubUpsertResult.Type;

export const ExowattThreadHubDeleteInput = Schema.Struct(ExowattThreadHubItemRef.fields);
export type ExowattThreadHubDeleteInput = typeof ExowattThreadHubDeleteInput.Type;

export const ExowattThreadHubDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type ExowattThreadHubDeleteResult = typeof ExowattThreadHubDeleteResult.Type;

export class ExowattThreadHubError extends Schema.TaggedError<ExowattThreadHubError>()(
  "ExowattThreadHubError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Hub ${this.operation} failed: ${this.reason}`;
  }
}

// ── MCP: `thread_hub_pin` ──────────────────────────────────────────────

export const ThreadHubPinInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread whose Hub to change." }),
  kind: ExowattThreadHubItemKind.annotate({
    description:
      "The item's kind. Outputs: file-output, pull-request, commit, link-output, preview, attachment, note-output. Sources: file-read, url-fetch, web-search, mcp-tool, skill, note-source.",
  }),
  key: ItemKey,
  pinned: Schema.optional(
    Schema.Boolean.annotate({ description: "Pin (true) or unpin (false). Omit to leave as is." }),
  ),
  hidden: Schema.optional(
    Schema.Boolean.annotate({ description: "Hide (true) or unhide (false). Omit to leave as is." }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_TITLE_CHARS)).annotate({
      description:
        "Adds the item by hand when set: the row's label. Pair with url (links), path (files) or note (notes).",
    }),
  ),
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_KEY_CHARS))),
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_KEY_CHARS))),
  note: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_NOTE_CHARS))),
});
export type ThreadHubPinInput = typeof ThreadHubPinInput.Type;

export const ThreadHubPinResult = Schema.Struct(ExowattThreadHubUpsertResult.fields);
export type ThreadHubPinResult = typeof ThreadHubPinResult.Type;

export class ThreadHubToolError extends Schema.TaggedError<ThreadHubToolError>()(
  "ThreadHubToolError",
  {
    tool: Schema.Literals(["thread_hub_pin"]),
    threadId: Schema.NullOr(ThreadId),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.tool} failed: ${this.detail}`;
  }
}
