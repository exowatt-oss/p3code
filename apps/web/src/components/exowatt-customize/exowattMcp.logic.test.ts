import { describe, expect, it } from "vite-plus/test";

import { environmentScopedValue, resolveMcpEnablementControl } from "./exowattMcp.logic";

const runtimeStatus = (enabled: boolean) => ({
  name: "demo",
  transport: "http" as const,
  enabled,
  authMode: "oauth" as const,
  credential: "valid" as const,
  needsLogin: false,
  loginInProgress: false,
});

describe("resolveMcpEnablementControl", () => {
  it("uses Phi effective status only when the installed CLI advertises control", () => {
    expect(
      resolveMcpEnablementControl({
        harness: "phi",
        rawStatus: "enabled",
        runtimeStatus: undefined,
        runtimeSupportsEnablement: false,
      }),
    ).toEqual({ enabled: undefined, canToggle: false });

    expect(
      resolveMcpEnablementControl({
        harness: "phi",
        rawStatus: "disabled",
        runtimeStatus: runtimeStatus(true),
        runtimeSupportsEnablement: true,
      }),
    ).toEqual({ enabled: true, canToggle: true });
  });

  it("keeps native raw-config toggles independent of Phi capability", () => {
    expect(
      resolveMcpEnablementControl({
        harness: "codex",
        rawStatus: "disabled",
        runtimeStatus: undefined,
        runtimeSupportsEnablement: false,
      }),
    ).toEqual({ enabled: false, canToggle: true });
  });
});

describe("environmentScopedValue", () => {
  it("hides stale rows immediately when the selected environment changes", () => {
    const stale = { environmentId: "old", value: ["old-row"] };
    expect(environmentScopedValue("new", stale, [])).toEqual([]);
    expect(environmentScopedValue("old", stale, [])).toEqual(["old-row"]);
  });
});
