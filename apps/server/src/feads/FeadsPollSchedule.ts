/**
 * When the feads poller runs next. Pure so the cadence is unit-tested: 20 s while things
 * work, doubling per consecutive failure up to five minutes, always with ±20% jitter so a
 * fleet of P3 servers does not hit feads in lockstep.
 *
 * @module FeadsPollSchedule
 */

export const FEADS_POLL_INTERVAL_MS = 20_000;
export const FEADS_POLL_MAX_BACKOFF_MS = 5 * 60_000;
/** Fraction of the base delay the jitter may add or remove. */
export const FEADS_POLL_JITTER = 0.2;

/**
 * @param consecutiveFailures polls in a row that hit a transport error, a 5xx
 *   or a refused token. A 404 (door not open yet) is not a failure.
 * @param random a draw in `[0, 1)`; `0.5` means no jitter.
 */
export function nextPollDelayMs(consecutiveFailures: number, random: number): number {
  const failures = Math.max(0, Math.floor(consecutiveFailures));
  const base =
    failures === 0
      ? FEADS_POLL_INTERVAL_MS
      : Math.min(FEADS_POLL_INTERVAL_MS * 2 ** failures, FEADS_POLL_MAX_BACKOFF_MS);
  const draw = Math.min(Math.max(random, 0), 1);
  const jitter = (draw * 2 - 1) * FEADS_POLL_JITTER;
  return Math.round(base * (1 + jitter));
}
