// exowatt: thread rows from a non-primary environment get a thin left-edge
// stripe so the machine is recognisable at a glance without costing layout.
// The theme has no chart palette, so these are mid-lightness oklch hues that
// read on both light and dark sidebars.
const ENVIRONMENT_STRIPE_PALETTE = [
  "oklch(0.65 0.2 295)", // violet
  "oklch(0.78 0.16 75)", // amber
  "oklch(0.72 0.13 200)", // cyan
  "oklch(0.7 0.2 350)", // pink
  "oklch(0.78 0.18 130)", // lime
  "oklch(0.72 0.18 45)", // orange
] as const;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stripe colour for a thread's environment; null for the primary (local) one. */
export function resolveEnvironmentStripeColor(
  environmentId: string,
  primaryEnvironmentId: string | null,
): string | null {
  if (environmentId === primaryEnvironmentId) return null;
  return ENVIRONMENT_STRIPE_PALETTE[hashString(environmentId) % ENVIRONMENT_STRIPE_PALETTE.length]!;
}
