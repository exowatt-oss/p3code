// Exowatt distro: thread signals, an orchestrator thread's report lane. Any agent can raise a
// one-line signal on its thread: green (done), yellow (needs the user) or red (error). An
// orchestrator thread reads open signals instead of each thread's last message; acking closes one.
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What a signal reports. */
export const ExowattThreadSignalLane = Schema.Literals(["green", "yellow", "red"]);
export type ExowattThreadSignalLane = typeof ExowattThreadSignalLane.Type;

const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_CHARS = 4000;
const MAX_LINK_CHARS = 2048;
const MAX_LINKS = 10;

const SignalTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_TITLE_CHARS));
const SignalDetail = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_DETAIL_CHARS));
const SignalLinks = Schema.Array(
  TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_LINK_CHARS)),
).check(Schema.isMaxLength(MAX_LINKS));

export const ExowattThreadSignal = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  lane: ExowattThreadSignalLane,
  title: SignalTitle,
  detail: Schema.NullOr(SignalDetail),
  links: SignalLinks,
  createdAt: IsoDateTime,
  ackedAt: Schema.NullOr(IsoDateTime),
});
export type ExowattThreadSignal = typeof ExowattThreadSignal.Type;

/** Ack by ids, or every open signal of one thread. At least one is required. */
export const ExowattThreadSignalsAckInput = Schema.Struct({
  ids: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  threadId: Schema.optional(ThreadId),
});
export type ExowattThreadSignalsAckInput = typeof ExowattThreadSignalsAckInput.Type;

export const ExowattThreadSignalsAckResult = Schema.Struct({ acked: Schema.Number });
export type ExowattThreadSignalsAckResult = typeof ExowattThreadSignalsAckResult.Type;

export class ExowattThreadSignalsError extends Schema.TaggedError<ExowattThreadSignalsError>()(
  "ExowattThreadSignalsError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Thread signals ${this.operation} failed: ${this.reason}`;
  }
}

// ── MCP: `t3_signal_emit`, `t3_thread_signals`, `t3_signal_ack` ──────────

export const ThreadSignalEmitInput = Schema.Struct({
  lane: ExowattThreadSignalLane.annotate({
    description:
      "green: something got done (a deliverable, a finished step). yellow: the user must act (a sign-in or unlock, a hands-on task on one of their machines, an important question you could not answer yourself). red: an error you could not recover from.",
  }),
  title: SignalTitle.annotate({
    description: "One crisp line the user reads at a glance, e.g. 'PR #42 merged, deploy green'.",
  }),
  detail: Schema.optional(
    SignalDetail.annotate({ description: "Optional extra context: the exact click path, error…" }),
  ),
  links: Schema.optional(
    SignalLinks.annotate({ description: "Optional URLs (PRs, pages, p3://thread links)." }),
  ),
  threadId: Schema.optional(
    ThreadId.annotate({
      description:
        "Only for callers outside a thread (`t3 agent token`). Agents in a thread omit it: the signal goes on the calling thread.",
    }),
  ),
});
export type ThreadSignalEmitInput = typeof ThreadSignalEmitInput.Type;

export const ThreadSignalEmitResult = Schema.Struct({ signal: ExowattThreadSignal });
export type ThreadSignalEmitResult = typeof ThreadSignalEmitResult.Type;

export const ThreadSignalsListInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Only this thread's signals. Omit for every thread." }),
  ),
  lane: Schema.optional(ExowattThreadSignalLane),
  includeAcked: Schema.optional(
    Schema.Boolean.annotate({ description: "Also return acked signals (newest 200)." }),
  ),
});
export type ThreadSignalsListInput = typeof ThreadSignalsListInput.Type;

export const ThreadSignalsListResult = Schema.Struct({
  signals: Schema.Array(ExowattThreadSignal),
});
export type ThreadSignalsListResult = typeof ThreadSignalsListResult.Type;

export const ThreadSignalAckInput = Schema.Struct({
  ids: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({ description: "Signal ids to ack." }),
  ),
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Ack every open signal of this thread." }),
  ),
});
export type ThreadSignalAckInput = typeof ThreadSignalAckInput.Type;

export const ThreadSignalAckResult = ExowattThreadSignalsAckResult;
export type ThreadSignalAckResult = ExowattThreadSignalsAckResult;

// Generated UI is gone; `t3_ui_render` stays registered as a no-op so running agents get a hint, not an error.
export const ThreadUiRenderInput = Schema.Struct({
  title: Schema.optional(Schema.Unknown),
  spec: Schema.optional(Schema.Unknown),
  threadId: Schema.optional(Schema.Unknown),
});
export type ThreadUiRenderInput = typeof ThreadUiRenderInput.Type;

export const ThreadUiRenderResult = Schema.Struct({ message: Schema.String });
export type ThreadUiRenderResult = typeof ThreadUiRenderResult.Type;

export class ThreadSignalsToolError extends Schema.TaggedError<ThreadSignalsToolError>()(
  "ThreadSignalsToolError",
  {
    tool: Schema.Literals(["t3_signal_emit", "t3_thread_signals", "t3_signal_ack", "t3_ui_render"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.tool} failed: ${this.detail}`;
  }
}
