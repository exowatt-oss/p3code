import { describe, expect, it } from "vite-plus/test";
import { resolveP3PetActivity, type P3PetActivityInput } from "./activity";

const idle: P3PetActivityInput = {
  threadKey: "local:thread",
  isWorking: false,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  latestTurnOutcome: null,
  completedAt: null,
  hasThreadError: false,
};

describe("P3 pet activity", () => {
  it("shows waiting even while a provider is running", () => {
    expect(resolveP3PetActivity({ ...idle, isWorking: true, hasPendingApproval: true }, idle)).toBe(
      "waiting-for-user",
    );
    expect(
      resolveP3PetActivity({ ...idle, isWorking: true, hasPendingUserInput: true }, idle),
    ).toBe("waiting-for-user");
  });
  it("shows new work over the previous turn's error", () => {
    expect(
      resolveP3PetActivity({ ...idle, isWorking: true, latestTurnOutcome: "failed" }, idle),
    ).toBe("working");
  });
  it("celebrates completion once, without celebrating historical threads", () => {
    const completed = {
      ...idle,
      latestTurnOutcome: "completed",
      completedAt: "2026-09-05T12:00:00Z",
    } as const;
    expect(resolveP3PetActivity(completed, { ...idle, isWorking: true })).toBe("success");
    expect(resolveP3PetActivity(completed, completed)).toBe("idle");
    expect(resolveP3PetActivity(completed, null)).toBe("idle");
    expect(resolveP3PetActivity({ ...completed, threadKey: "remote:other" }, idle)).toBe("idle");
  });
  it("handles provider failures and interruptions", () => {
    expect(resolveP3PetActivity({ ...idle, latestTurnOutcome: "failed" }, idle)).toBe("error");
    expect(resolveP3PetActivity({ ...idle, hasThreadError: true }, idle)).toBe("error");
    expect(resolveP3PetActivity({ ...idle, latestTurnOutcome: "interrupted" }, idle)).toBe("idle");
  });
});
