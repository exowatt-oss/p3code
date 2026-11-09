/**
 * Exowatt distro: one way to compare MCP urls in harness configs. The Customize page, connector
 * tools and auto-connect reconciler all ask "is this the same server?" about typed strings.
 */

/**
 * Compare two MCP urls the way a harness config would: scheme and host are
 * case-insensitive, a trailing slash means nothing, and everything else has to
 * match exactly. Anything unparseable falls back to a trimmed compare so a
 * hand-written entry still counts as the same server.
 */
export function normalizeMcpUrl(url: string | undefined | null): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}
