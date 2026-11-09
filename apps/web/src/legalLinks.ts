// Self-hosted source builds have no Exowatt-hosted privacy policy. A future
// distributor can publish its own policy and opt in at build time.
const configuredPolicyUrl = import.meta.env.VITE_P3_PRIVACY_POLICY_URL?.trim();

export const PRIVACY_POLICY_URL: string | null = (() => {
  if (!configuredPolicyUrl) return null;
  try {
    const url = new URL(configuredPolicyUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
})();
