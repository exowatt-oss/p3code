import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "./orchestrationInstructions.ts";

// exowatt: agents link other threads as `p3://thread/<id>` and PRs by full URL (plan D3).
describe("P3 orchestration instructions", () => {
  it("instructs agents to link other threads and PRs", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "[title](p3://thread/<threadId>)");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "thread:project:");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "percent-encoded as one URL path segment");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "including Markdown delimiters such as `)`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Escape backslashes and square brackets");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "full GitHub URLs, never bare PR numbers");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "t3-thread://");
  });

  it("keeps every section under Codex's 4,000-byte entry limit", () => {
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      assert.isBelow(new TextEncoder().encode(section).length, 4_000);
    }
  });
});
