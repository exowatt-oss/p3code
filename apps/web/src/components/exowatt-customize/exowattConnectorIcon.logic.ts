// Exowatt distro: which glyph stands for an MCP connector on Customize › MCP. Brand marks
// come from `simple-icons` (CC0), matched on host first and name second (Claude Code
// prefixes claude.ai connectors; Google's share googleapis.com). Nothing is fetched: a
// favicon service would tell a third party which internal servers someone connected.
import {
  siAsana,
  siAtlassian,
  siBox,
  siClaude,
  siConfluence,
  siExpensify,
  siFigma,
  siGithub,
  siGmail,
  siGoogle,
  siGooglecalendar,
  siGoogledrive,
  siGrafana,
  siHubspot,
  siHuggingface,
  siInfluxdb,
  siIntercom,
  siJira,
  siLinear,
  siMermaid,
  siNotion,
  siTailscale,
  siWebflow,
  siZoom,
  type SimpleIcon,
} from "simple-icons";

/** Claude Code's prefix for connectors that come from the person's claude.ai account. */
const CLAUDE_AI_CONNECTOR_PREFIX = "claude.ai ";

export type ExowattConnectorGlyph =
  /** A brand mark: `path` is a 24×24 SVG path, `hex` the brand color without `#`. */
  | { readonly kind: "brand"; readonly title: string; readonly hex: string; readonly path: string }
  /** One of Exowatt's own servers (`*.example.org`, feads, team activity). */
  | { readonly kind: "exowatt"; readonly title: string }
  /** This P3 server itself. */
  | { readonly kind: "p3"; readonly title: string }
  /** No mark on file: a one- or two-letter tile from the name. */
  | { readonly kind: "monogram"; readonly title: string; readonly letters: string };

interface BrandRule {
  /** Matched against the end of the connector's hostname, e.g. `notion.com`. */
  readonly hosts?: ReadonlyArray<string>;
  /** Matched as whole words against the lower-cased display name. */
  readonly names?: ReadonlyArray<string>;
  readonly icon: SimpleIcon;
}

/**
 * Order matters where a host is shared: Google's connectors are all under
 * googleapis.com, so Gmail, Drive and Calendar are told apart by the subdomain
 * or the name before the generic Google mark catches the rest.
 */
const BRAND_RULES: ReadonlyArray<BrandRule> = [
  { hosts: ["gmailmcp.googleapis.com", "gmail.com"], names: ["gmail"], icon: siGmail },
  { hosts: ["drivemcp.googleapis.com"], names: ["google drive", "drive"], icon: siGoogledrive },
  {
    hosts: ["calendarmcp.googleapis.com"],
    names: ["google calendar", "calendar"],
    icon: siGooglecalendar,
  },
  { hosts: ["googleapis.com", "google.com"], names: ["google"], icon: siGoogle },
  { hosts: ["atlassian.com", "atlassian.net"], names: ["atlassian"], icon: siAtlassian },
  { names: ["jira"], icon: siJira },
  { names: ["confluence"], icon: siConfluence },
  { hosts: ["notion.com", "notion.so"], names: ["notion"], icon: siNotion },
  { hosts: ["linear.app"], names: ["linear"], icon: siLinear },
  { hosts: ["figma.com"], names: ["figma"], icon: siFigma },
  { hosts: ["box.com"], names: ["box"], icon: siBox },
  { hosts: ["asana.com"], names: ["asana"], icon: siAsana },
  { hosts: ["hubspot.com"], names: ["hubspot"], icon: siHubspot },
  { hosts: ["intercom.com", "intercom.io"], names: ["intercom"], icon: siIntercom },
  { hosts: ["zoom.us", "zoom.com"], names: ["zoom"], icon: siZoom },
  { hosts: ["huggingface.co"], names: ["hugging face", "huggingface"], icon: siHuggingface },
  { hosts: ["webflow.com"], names: ["webflow"], icon: siWebflow },
  { hosts: ["expensify.com"], names: ["expensify"], icon: siExpensify },
  {
    hosts: ["mermaid.ai", "mermaidchart.com"],
    names: ["mermaid", "mermaid chart"],
    icon: siMermaid,
  },
  { hosts: ["github.com", "githubcopilot.com"], names: ["github"], icon: siGithub },
  { names: ["grafana", "grafana-influx"], icon: siGrafana },
  { names: ["influx", "influxdb"], icon: siInfluxdb },
  { hosts: ["ts.net", "tailscale.com"], names: ["tailscale"], icon: siTailscale },
  {
    hosts: ["anthropic.com", "claude.ai", "claude.com"],
    names: ["claude", "anthropic", "claude-help-mcp"],
    icon: siClaude,
  },
];

const EXOWATT_HOSTS = [] as const;
const EXOWATT_NAMES = new Set(["feads", "team-activity", "team activity", "fluxbots", "exowatt"]);
const P3_NAMES = new Set(["p3", "p3 code", "t3-code", "t3code"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The name without Claude Code's claude.ai prefix, for a row title. */
export function connectorDisplayName(name: string): string {
  return name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)
    ? name.slice(CLAUDE_AI_CONNECTOR_PREFIX.length).trim() || name
    : name;
}

function connectorHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(hostname: string | null, suffixes: ReadonlyArray<string>): boolean {
  if (hostname === null) return false;
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function nameMatches(lowered: string, names: ReadonlyArray<string>): boolean {
  return names.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "u").test(lowered);
  });
}

/**
 * Two letters for a connector with no mark: the initials of the first two
 * words, or the first two letters of a one-word name. "Super Charles" → SC,
 * "monday" → MO, "Zip" → ZI.
 */
export function connectorMonogram(displayName: string): string {
  const words = displayName
    .split(/[\s._-]+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/** What to draw for one connector, from its name and the address it talks to. */
export function resolveConnectorGlyph(input: {
  readonly name: string;
  readonly url?: string | null | undefined;
}): ExowattConnectorGlyph {
  const title = connectorDisplayName(input.name);
  const lowered = title.toLowerCase();
  const hostname = connectorHostname(input.url);

  if (P3_NAMES.has(lowered) || (hostname !== null && LOOPBACK_HOSTS.has(hostname))) {
    return { kind: "p3", title };
  }
  for (const rule of BRAND_RULES) {
    if (hostMatches(hostname, rule.hosts ?? []) || nameMatches(lowered, rule.names ?? [])) {
      return { kind: "brand", title, hex: rule.icon.hex, path: rule.icon.path };
    }
  }
  if (hostMatches(hostname, EXOWATT_HOSTS) || EXOWATT_NAMES.has(lowered)) {
    return { kind: "exowatt", title };
  }
  return { kind: "monogram", title, letters: connectorMonogram(title) };
}

/**
 * The fill for a brand mark. Brands that are near-black (Notion, GitHub,
 * Anthropic) vanish on a dark background, and near-white ones on a light one,
 * so those take the surrounding text color instead of their own.
 */
export function brandFill(hex: string): string | null {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value) || hex.length !== 6) return null;
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance < 0.05 || luminance > 0.85 ? null : `#${hex}`;
}
