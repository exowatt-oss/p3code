import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_FOCUS_REQUEST_MAX_AGE_MS,
  threadFocusRequestToApply,
} from "./useThreadFocusRequest";

const REQUESTED_AT = "2026-09-19T17:00:00.000Z";
const BASE = {
  environmentId: "env-1",
  threadId: "thread-1",
  requestedAt: REQUESTED_AT,
  appliedGeneration: null,
  now: Date.parse(REQUESTED_AT) + 1_000,
} as const;

describe("thread focus request adoption", () => {
  it("acts on a request this client has not seen", () => {
    expect(threadFocusRequestToApply(BASE)).toBe(REQUESTED_AT);
  });

  it("does not replay a generation it already acted on", () => {
    expect(threadFocusRequestToApply({ ...BASE, appliedGeneration: REQUESTED_AT })).toBe(null);
  });

  // Asking for the same thread again must still act, which is why the
  // generation is the request time and not the thread id.
  it("acts again when the same thread is requested anew", () => {
    const later = "2026-09-19T17:05:00.000Z";
    expect(
      threadFocusRequestToApply({
        ...BASE,
        requestedAt: later,
        now: Date.parse(later) + 1_000,
        appliedGeneration: REQUESTED_AT,
      }),
    ).toBe(later);
  });

  // A client that connects long after the request was made must not be
  // dragged to a thread nobody is asking about any more.
  it("ignores a stale request", () => {
    expect(
      threadFocusRequestToApply({
        ...BASE,
        now: Date.parse(REQUESTED_AT) + THREAD_FOCUS_REQUEST_MAX_AGE_MS + 1,
      }),
    ).toBe(null);
  });

  it("leaves a client alone with no environment, no request, or an unreadable time", () => {
    expect(threadFocusRequestToApply({ ...BASE, environmentId: null })).toBe(null);
    expect(threadFocusRequestToApply({ ...BASE, threadId: "", requestedAt: "" })).toBe(null);
    expect(threadFocusRequestToApply({ ...BASE, requestedAt: "not a time" })).toBe(null);
  });
});
