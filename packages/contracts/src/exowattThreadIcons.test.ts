import { describe, expect, it } from "vite-plus/test";

import {
  EXOWATT_THREAD_ICON_NAMES,
  fallbackExowattThreadIcon,
  isExowattThreadIconName,
} from "./exowattThreadIcons.ts";

describe("exowatt thread icons", () => {
  it("lists each icon once", () => {
    expect(new Set(EXOWATT_THREAD_ICON_NAMES).size).toBe(EXOWATT_THREAD_ICON_NAMES.length);
  });

  it("picks by keyword", () => {
    expect(fallbackExowattThreadIcon("Fix the login crash")).toBe("bug");
    expect(fallbackExowattThreadIcon("Review PR #212")).toBe("magnifying-glass-chart");
    expect(fallbackExowattThreadIcon("Deploy the board to prod")).toBe("rocket");
    expect(fallbackExowattThreadIcon("Research Meshy pricing")).toBe("magnifying-glass");
    expect(fallbackExowattThreadIcon("Book the pugs a vet visit")).toBe("heart-pulse");
  });

  it("hashes other titles onto a stable allowlisted icon", () => {
    const first = fallbackExowattThreadIcon("Quarterly offsite");
    expect(fallbackExowattThreadIcon("Quarterly offsite")).toBe(first);
    expect(isExowattThreadIconName(first)).toBe(true);
    expect(isExowattThreadIconName("not-an-icon")).toBe(false);
  });
});
