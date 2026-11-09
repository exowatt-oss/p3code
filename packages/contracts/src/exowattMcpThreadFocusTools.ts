// Exowatt distro: MCP tool contract for bringing a thread on screen. An agent or control surface
// records a focus request (ServerSettings.exowattThreadFocusRequest); every connected client
// navigates to it once and ignores a stale one. See `useThreadFocusRequestAdoption` in apps/web.
import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";

export const ThreadFocusInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to bring on screen." }),
});
export type ThreadFocusInput = typeof ThreadFocusInput.Type;

export const ThreadFocusResult = Schema.Struct({
  threadId: ThreadId,
  /** The request generation; clients act on each generation exactly once. */
  requestedAt: IsoDateTime,
});
export type ThreadFocusResult = typeof ThreadFocusResult.Type;

export const ThreadFocusToolName = Schema.Literals(["thread_focus"]);
export type ThreadFocusToolName = typeof ThreadFocusToolName.Type;

export class ThreadFocusToolError extends Schema.TaggedError<ThreadFocusToolError>()(
  "ThreadFocusToolError",
  {
    tool: ThreadFocusToolName,
    threadId: Schema.NullOr(ThreadId),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.tool} failed: ${this.detail}`;
  }
}
