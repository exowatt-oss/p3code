import { describe, expect, it } from "vite-plus/test";

import {
  FEADS_POLL_INTERVAL_MS,
  FEADS_POLL_JITTER,
  FEADS_POLL_MAX_BACKOFF_MS,
  nextPollDelayMs,
} from "./FeadsPollSchedule.ts";

describe("nextPollDelayMs", () => {
  it("polls every 20 s while things work, with no jitter at the midpoint draw", () => {
    expect(nextPollDelayMs(0, 0.5)).toBe(FEADS_POLL_INTERVAL_MS);
  });

  it("jitters ±20% around the base", () => {
    expect(nextPollDelayMs(0, 0)).toBe(FEADS_POLL_INTERVAL_MS * (1 - FEADS_POLL_JITTER));
    expect(nextPollDelayMs(0, 1)).toBe(FEADS_POLL_INTERVAL_MS * (1 + FEADS_POLL_JITTER));
    for (const draw of [0.1, 0.33, 0.77, 0.999]) {
      const delay = nextPollDelayMs(0, draw);
      expect(delay).toBeGreaterThanOrEqual(FEADS_POLL_INTERVAL_MS * (1 - FEADS_POLL_JITTER));
      expect(delay).toBeLessThanOrEqual(FEADS_POLL_INTERVAL_MS * (1 + FEADS_POLL_JITTER));
    }
  });

  it("doubles per consecutive failure and caps at five minutes", () => {
    expect(nextPollDelayMs(1, 0.5)).toBe(40_000);
    expect(nextPollDelayMs(2, 0.5)).toBe(80_000);
    expect(nextPollDelayMs(3, 0.5)).toBe(160_000);
    expect(nextPollDelayMs(4, 0.5)).toBe(FEADS_POLL_MAX_BACKOFF_MS);
    expect(nextPollDelayMs(12, 0.5)).toBe(FEADS_POLL_MAX_BACKOFF_MS);
    // Jitter still applies at the cap, so a fleet does not retry in lockstep.
    expect(nextPollDelayMs(12, 1)).toBe(FEADS_POLL_MAX_BACKOFF_MS * (1 + FEADS_POLL_JITTER));
  });

  it("tolerates odd inputs", () => {
    expect(nextPollDelayMs(-3, 0.5)).toBe(FEADS_POLL_INTERVAL_MS);
    expect(nextPollDelayMs(1.7, 0.5)).toBe(40_000);
    expect(nextPollDelayMs(0, 7)).toBe(FEADS_POLL_INTERVAL_MS * (1 + FEADS_POLL_JITTER));
    expect(nextPollDelayMs(0, -7)).toBe(FEADS_POLL_INTERVAL_MS * (1 - FEADS_POLL_JITTER));
  });
});
