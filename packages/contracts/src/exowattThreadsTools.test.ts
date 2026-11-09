import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ThreadsDeleteThreadInput,
  ThreadsThreadListInput,
  ThreadsSummariesInput,
  ThreadsToolError,
} from "./exowattThreadsTools.ts";

const decodeThreadListInput = Schema.decodeUnknownSync(ThreadsThreadListInput);
const decodeSummariesInput = Schema.decodeUnknownSync(ThreadsSummariesInput);
const decodeDeleteInput = Schema.decodeUnknownSync(ThreadsDeleteThreadInput);

describe("Threads MCP contract", () => {
  it("validates sweep timestamps and summary selectors", () => {
    expect(() => decodeThreadListInput({ updatedAfter: "not-a-timestamp" })).toThrow();
    expect(decodeThreadListInput({ updatedAfter: "2026-09-03T08:00:00-04:00" }).updatedAfter).toBe(
      "2026-09-03T08:00:00-04:00",
    );

    // includeSettled is optional so existing callers keep the old behaviour.
    expect(decodeThreadListInput({}).includeSettled).toBeUndefined();
    expect(decodeThreadListInput({ includeSettled: false }).includeSettled).toBe(false);
    expect(() => decodeThreadListInput({ includeSettled: "no" })).toThrow();

    expect(() => decodeSummariesInput({ threadIds: [] })).toThrow();
    expect(() =>
      decodeSummariesInput({
        threadIds: Array.from({ length: 21 }, (_, index) => `thread-${index}`),
      }),
    ).toThrow();
    expect(() =>
      decodeSummariesInput({ threadId: "thread-one", threadIds: ["thread-two"] }),
    ).toThrow();
    expect(decodeSummariesInput({ threadIds: ["thread-one"] }).threadIds).toEqual(["thread-one"]);
  });

  it("refuses a destructive call without confirm: true", () => {
    expect(() => decodeDeleteInput({ threadId: "thread-one" })).toThrow();
    expect(() => decodeDeleteInput({ threadId: "thread-one", confirm: false })).toThrow();
    expect(decodeDeleteInput({ threadId: "thread-one", confirm: true }).confirm).toBe(true);
  });

  it("keeps the legacy error tag clients match on", () => {
    expect(new ThreadsToolError({ tool: "thread_list", threadId: null, detail: "test" })._tag).toBe(
      "CommandCenterToolError",
    );
  });
});
