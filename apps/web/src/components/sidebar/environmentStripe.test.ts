import { describe, expect, it } from "vite-plus/test";

import { resolveEnvironmentStripeColor } from "./environmentStripe";

describe("resolveEnvironmentStripeColor", () => {
  it("shows no stripe for the primary environment", () => {
    expect(resolveEnvironmentStripeColor("env-local", "env-local")).toBeNull();
  });

  it("gives a remote environment a stable colour", () => {
    const first = resolveEnvironmentStripeColor("env-devbox", "env-local");
    expect(first).toEqual(expect.any(String));
    expect(resolveEnvironmentStripeColor("env-devbox", "env-local")).toBe(first);
  });

  it("distinguishes at least some environments", () => {
    const colors = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => resolveEnvironmentStripeColor(id, null)),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});
