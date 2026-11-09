import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveRunningSubagentActivity } from "./subagentActivity.logic";

const NOW = Date.parse("2026-10-06T12:10:00.000Z");
const startedAt = "2026-10-06T12:00:00.000Z";
const defaults = {
  status: "running",
  startedAt,
  updatedAt: "2026-10-06T12:09:00.000Z",
  progress: null,
  childTurnItems: [] as OrchestrationV2TurnItem[],
};

function tool(at: string, title: string): OrchestrationV2TurnItem {
  return {
    type: "dynamic_tool",
    title,
    toolName: "bash",
    updatedAt: DateTime.makeUnsafe(at),
  } as OrchestrationV2TurnItem;
}

function prompt(at: string): OrchestrationV2TurnItem {
  return { type: "user_message", updatedAt: DateTime.makeUnsafe(at) } as OrchestrationV2TurnItem;
}

describe("deriveRunningSubagentActivity", () => {
  it("reports the child's latest tool rather than its initial prompt or parent metadata", () => {
    expect(
      deriveRunningSubagentActivity(
        {
          ...defaults,
          childTurnItems: [
            prompt("2026-10-06T12:09:50.000Z"),
            tool("2026-10-06T12:07:00.000Z", "$ rg subagent"),
          ],
        },
        NOW,
      ),
    ).toEqual({ age: "last activity 3m ago", action: "$ rg subagent", idle: false });
  });

  it("falls back to a real progress receipt when no child tool is available", () => {
    expect(
      deriveRunningSubagentActivity({ ...defaults, progress: "  scanning  files \n" }, NOW),
    ).toEqual({ age: "last update 1m ago", action: "scanning files", idle: false });
  });

  it("never treats bare updatedAt or a prompt as activity, nor shows activity after completion", () => {
    expect(deriveRunningSubagentActivity(defaults, NOW)).toBeNull();
    expect(
      deriveRunningSubagentActivity({ ...defaults, childTurnItems: [prompt(startedAt)] }, NOW),
    ).toBeNull();
    expect(
      deriveRunningSubagentActivity({ ...defaults, progress: "working", status: "completed" }, NOW),
    ).toBeNull();
    expect(
      deriveRunningSubagentActivity(
        { ...defaults, progress: "working", updatedAt: "not a timestamp" },
        NOW,
      ),
    ).toBeNull();
  });

  it("marks only observed inactivity of at least five minutes, excluding previous runs", () => {
    const oldTool = tool("2026-10-06T12:04:59.000Z", "last command");
    expect(deriveRunningSubagentActivity({ ...defaults, childTurnItems: [oldTool] }, NOW)).toEqual({
      age: "last activity 5m ago",
      action: "last command",
      idle: true,
    });
    expect(
      deriveRunningSubagentActivity(
        { ...defaults, childTurnItems: [tool("2026-10-06T12:05:01.000Z", "new command")] },
        NOW,
      )?.idle,
    ).toBe(false);
    expect(
      deriveRunningSubagentActivity(
        { ...defaults, startedAt: "2026-10-06T12:06:00.000Z", childTurnItems: [oldTool] },
        NOW,
      ),
    ).toBeNull();
  });
});
