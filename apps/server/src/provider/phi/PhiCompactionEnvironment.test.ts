import { describe, expect, it } from "vite-plus/test";

import { phiCompactionEnvironment } from "./PhiCompactionEnvironment.ts";

describe("Phi compaction environment", () => {
  it("turns context-aware compaction on by default with a 500k ceiling", () => {
    expect(phiCompactionEnvironment({ environment: { PATH: "/bin" } })).toEqual({
      PI_CONTEXT_BUDGET: "on",
      PI_COMPACTION_SOFT_CEILING_TOKENS: "500000",
    });
  });

  it("keeps a user opt-out", () => {
    expect(phiCompactionEnvironment({ environment: { PI_CONTEXT_BUDGET: "off" } })).toEqual({
      PI_COMPACTION_SOFT_CEILING_TOKENS: "500000",
    });
  });

  it("keeps a ceiling the user chose", () => {
    expect(
      phiCompactionEnvironment({ environment: { PI_COMPACTION_SOFT_CEILING_TOKENS: "0" } }),
    ).toEqual({ PI_CONTEXT_BUDGET: "on" });
  });

  it("treats a blank value as unset", () => {
    expect(
      phiCompactionEnvironment({
        environment: { PI_CONTEXT_BUDGET: " ", PI_COMPACTION_SOFT_CEILING_TOKENS: "" },
      }),
    ).toEqual({ PI_CONTEXT_BUDGET: "on", PI_COMPACTION_SOFT_CEILING_TOKENS: "500000" });
  });
});
