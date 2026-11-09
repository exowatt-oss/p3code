import { describe, expect, it } from "vite-plus/test";

import { phiFeadsDisabled, phiFeadsEnvironment } from "./PhiFeadsEnvironment.ts";

describe("Phi feads presence environment", () => {
  it("announces the P3 client even with no feads credential anywhere", () => {
    expect(phiFeadsEnvironment({ environment: { PATH: "/bin" } })).toEqual({ PHI_CLIENT: "p3" });
  });

  it("keeps a client name the user set themselves", () => {
    expect(
      phiFeadsEnvironment({ environment: { PHI_CLIENT: "custom", FEADS_AGENT_TOKEN: "fdsa_env" } }),
    ).toEqual({ FEADS_AGENT_TOKEN: "fdsa_env" });
  });

  it("forwards the captured shell token under the canonical name", () => {
    expect(
      phiFeadsEnvironment({
        environment: { FEADS_AGENT_TOKEN: "fdsa_env", FEADS_URL: "https://feads.test" },
      }),
    ).toEqual({
      PHI_CLIENT: "p3",
      FEADS_AGENT_TOKEN: "fdsa_env",
      FEADS_URL: "https://feads.test",
    });
  });

  it("promotes the legacy token name to the canonical one", () => {
    expect(phiFeadsEnvironment({ environment: { FEADS_TOKEN: "fdsa_legacy" } })).toEqual({
      PHI_CLIENT: "p3",
      FEADS_AGENT_TOKEN: "fdsa_legacy",
    });
  });

  it("prefers the token P3 has configured over both environment names", () => {
    expect(
      phiFeadsEnvironment({
        environment: {
          FEADS_AGENT_TOKEN: "fdsa_env",
          FEADS_TOKEN: "fdsa_legacy",
          FEADS_URL: "https://env.test",
        },
        p3Feads: { token: "fdsa_p3", baseUrl: "https://p3.test" },
      }),
    ).toEqual({
      PHI_CLIENT: "p3",
      FEADS_AGENT_TOKEN: "fdsa_p3",
      FEADS_URL: "https://p3.test",
    });
  });

  it("falls back through blank and unconfigured P3 values", () => {
    expect(
      phiFeadsEnvironment({
        environment: { FEADS_TOKEN: "fdsa_legacy" },
        p3Feads: { token: null, baseUrl: null },
      }),
    ).toEqual({ PHI_CLIENT: "p3", FEADS_AGENT_TOKEN: "fdsa_legacy" });
    expect(
      phiFeadsEnvironment({
        environment: { FEADS_AGENT_TOKEN: "   ", FEADS_URL: "  " },
      }),
    ).toEqual({ PHI_CLIENT: "p3" });
  });

  it("leaves the feads URL to Phi's own default when nobody set one", () => {
    expect(
      phiFeadsEnvironment({ environment: {}, p3Feads: { token: "fdsa_p3", baseUrl: null } }),
    ).toEqual({ PHI_CLIENT: "p3", FEADS_AGENT_TOKEN: "fdsa_p3" });
  });

  it("forwards no credential when feads is switched off for the runtime", () => {
    for (const value of ["1", "true", "yes"]) {
      expect(
        phiFeadsEnvironment({
          environment: { PI_NO_FEADS: value, FEADS_AGENT_TOKEN: "fdsa_env" },
          p3Feads: { token: "fdsa_p3", baseUrl: "https://p3.test" },
        }),
      ).toEqual({ PHI_CLIENT: "p3" });
    }
  });

  it("treats an explicitly falsey kill switch as feads enabled", () => {
    for (const value of ["0", "false", ""]) {
      expect(phiFeadsDisabled({ PI_NO_FEADS: value })).toBe(false);
    }
    expect(phiFeadsDisabled({})).toBe(false);
    expect(phiFeadsDisabled({ PI_NO_FEADS: "1" })).toBe(true);
  });
});
