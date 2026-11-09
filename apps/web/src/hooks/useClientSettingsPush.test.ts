import { describe, expect, it } from "vite-plus/test";

import { clientSettingsPushToApply } from "./useClientSettingsPush";

const BASE = {
  environmentId: "env-1",
  setAt: "2026-09-09T00:00:00.000Z",
  patch: { glassOpacity: 90 },
  appliedGeneration: null,
  hydrated: true,
} as const;

describe("client settings push adoption", () => {
  it("applies a push this client has not seen", () => {
    expect(clientSettingsPushToApply(BASE)).toBe(BASE.setAt);
  });

  it("does not replay a generation it already applied", () => {
    expect(clientSettingsPushToApply({ ...BASE, appliedGeneration: BASE.setAt })).toBe(null);
  });

  // Re-pushing the same values must still act, which is why the generation is
  // the set time and not the patch contents.
  it("applies the same patch again when the environment re-pushes it", () => {
    expect(
      clientSettingsPushToApply({
        ...BASE,
        setAt: "2026-09-09T01:00:00.000Z",
        appliedGeneration: BASE.setAt,
      }),
    ).toBe("2026-09-09T01:00:00.000Z");
  });

  // Applying onto the pre-hydration defaults would persist defaults over the
  // user's saved preferences.
  it("waits for the client's own settings to hydrate", () => {
    expect(clientSettingsPushToApply({ ...BASE, hydrated: false })).toBe(null);
  });

  it("leaves a client alone with no environment, no push, or an empty patch", () => {
    expect(clientSettingsPushToApply({ ...BASE, environmentId: null })).toBe(null);
    expect(clientSettingsPushToApply({ ...BASE, setAt: "" })).toBe(null);
    expect(clientSettingsPushToApply({ ...BASE, patch: {} })).toBe(null);
  });
});
