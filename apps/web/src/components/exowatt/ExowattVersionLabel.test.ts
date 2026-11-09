import { describe, expect, it } from "vite-plus/test";

import { formatExowattVersionLabel } from "./ExowattVersionLabel";

describe("formatExowattVersionLabel", () => {
  it("formats the upstream base and compact P3 release suffix", () => {
    expect(formatExowattVersionLabel("0.0.37-exowatt.12", false)).toEqual({
      compactLabel: "T3 0.0.37 · P3 exowatt.12",
      t3VersionLabel: "t3code v0.0.37",
      p3VersionLabel: "P3 Code v0.0.37-exowatt.12",
      copyText: "t3code v0.0.37\nP3 Code v0.0.37-exowatt.12",
    });
  });

  it("marks the P3 build as dev while preserving the local upstream base", () => {
    expect(formatExowattVersionLabel("0.0.37", true)).toEqual({
      compactLabel: "T3 0.0.37 · P3 dev",
      t3VersionLabel: "t3code v0.0.37",
      p3VersionLabel: "P3 Code dev",
      copyText: "t3code v0.0.37\nP3 Code dev",
    });
  });

  it("shows the checkout's short sha in dev so the running commit is visible", () => {
    expect(formatExowattVersionLabel("0.0.37", true, "61e39a3bc0ffee")).toEqual({
      compactLabel: "T3 0.0.37 · P3 dev·61e39a3",
      t3VersionLabel: "t3code v0.0.37",
      p3VersionLabel: "P3 Code dev @ 61e39a3",
      copyText: "t3code v0.0.37\nP3 Code dev @ 61e39a3",
    });
  });

  it("never shows a sha on release builds", () => {
    expect(formatExowattVersionLabel("0.0.37-exowatt.12", false, "61e39a3").compactLabel).toBe(
      "T3 0.0.37 · P3 exowatt.12",
    );
  });
});
