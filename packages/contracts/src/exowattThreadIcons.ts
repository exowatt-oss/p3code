// Exowatt distro: a Font Awesome icon per thread, picked by the text-generation model from this
// list when the thread gets its title and drawn on subagent rows. The list is the contract: the
// model's output schema is an enum of these names and the web client imports exactly these
// glyphs, so an unknown icon can never be stored.
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/** Font Awesome 7 free-solid icon names a thread can carry. */
export const EXOWATT_THREAD_ICON_NAMES = [
  // Code and engineering
  "code",
  "file-code",
  "terminal",
  "bug",
  "bug-slash",
  "code-branch",
  "code-merge",
  "code-pull-request",
  "code-compare",
  "flask",
  "vial",
  "database",
  "server",
  "cloud",
  "network-wired",
  "plug",
  "microchip",
  "gear",
  "sliders",
  "wrench",
  "screwdriver-wrench",
  "hammer",
  "broom",
  "arrows-rotate",
  "rocket",
  "cube",
  "cubes",
  "box-open",
  "layer-group",
  "sitemap",
  "diagram-project",
  "puzzle-piece",
  "link",
  "download",
  "upload",
  "gauge-high",
  "lock",
  "key",
  "shield-halved",
  "triangle-exclamation",
  "robot",
  "atom",
  "keyboard",
  "font",
  // Product, design, devices
  "palette",
  "paintbrush",
  "pen-nib",
  "shapes",
  "image",
  "camera",
  "video",
  "film",
  "music",
  "mobile-screen",
  "desktop",
  "window-maximize",
  "gamepad",
  // Research, writing, data
  "magnifying-glass",
  "magnifying-glass-chart",
  "eye",
  "book-open",
  "file-lines",
  "file-pen",
  "newspaper",
  "graduation-cap",
  "lightbulb",
  "brain",
  "wand-magic-sparkles",
  "chart-line",
  "chart-pie",
  "table",
  "folder-open",
  "circle-question",
  "scale-balanced",
  // Communication and planning
  "envelope",
  "comment",
  "comments",
  "bell",
  "satellite-dish",
  "tower-broadcast",
  "calendar-days",
  "list-check",
  "clipboard-check",
  "flag-checkered",
  "trophy",
  "star",
  "user",
  "users",
  "briefcase",
  "building",
  // Money and commerce
  "dollar-sign",
  "credit-card",
  "receipt",
  "cart-shopping",
  "truck",
  // Life and the world
  "globe",
  "map",
  "map-location-dot",
  "compass",
  "route",
  "plane",
  "car",
  "house",
  "heart-pulse",
  "stethoscope",
  "dumbbell",
  "utensils",
  "mug-hot",
  "paw",
  "leaf",
  "seedling",
  "tree",
  "sun",
  "moon",
  "bolt",
  "fire",
] as const;

export const ExowattThreadIconName = Schema.Literals(EXOWATT_THREAD_ICON_NAMES);
export type ExowattThreadIconName = typeof ExowattThreadIconName.Type;

const ICON_NAME_SET: ReadonlySet<string> = new Set(EXOWATT_THREAD_ICON_NAMES);

export function isExowattThreadIconName(value: string): value is ExowattThreadIconName {
  return ICON_NAME_SET.has(value);
}

/**
 * Keyword rules for the deterministic pick: used until (or instead of) a
 * generated icon, and when text generation fails. First match wins, so the
 * more specific words come first.
 */
const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, ExowattThreadIconName]> = [
  [/\b(review|audit|critique|inspect)\w*/, "magnifying-glass-chart"],
  [/\b(bug|fix|crash|regression|broken|error|debug)\w*/, "bug"],
  [/\b(test|spec|e2e|vitest|jest|qa)\w*/, "flask"],
  [/\b(pr|pull request|merge|rebase)\b/, "code-pull-request"],
  [/\b(branch|worktree|git|commit)\w*/, "code-branch"],
  [/\b(deploy|release|ship|launch|rollout)\w*/, "rocket"],
  [/\b(research|investigat|explor|search|find|look up|lookup)\w*/, "magnifying-glass"],
  [/\b(doc|docs|readme|write-?up|spec)\w*/, "file-lines"],
  [/\b(design|ui|ux|style|css|theme|layout|figma)\w*/, "palette"],
  [/\b(icon|image|screenshot|photo|picture)\w*/, "image"],
  [/\b(video|render|animation|motion)\w*/, "film"],
  [/\b(database|sql|sqlite|postgres|migration|schema)\w*/, "database"],
  [/\b(server|backend|api|endpoint|rpc)\w*/, "server"],
  [/\b(cloud|aws|gcp|infra|terraform|kubernetes|docker)\w*/, "cloud"],
  [/\b(perf|performance|latency|speed|optimi[sz])\w*/, "gauge-high"],
  [/\b(security|auth|token|secret|permission|tcc|oauth)\w*/, "shield-halved"],
  [/\b(refactor|cleanup|clean up|lint|format)\w*/, "broom"],
  [/\b(config|setting|setup|install)\w*/, "gear"],
  [/\b(mobile|ios|android|iphone|app store|testflight)\w*/, "mobile-screen"],
  [/\b(email|mail|inbox)\w*/, "envelope"],
  [/\b(message|chat|slack|buzz|text|imessage)\w*/, "comments"],
  [/\b(calendar|schedule|meeting|reminder)\w*/, "calendar-days"],
  [/\b(plan|todo|task|checklist|roadmap)\w*/, "list-check"],
  [/\b(data|metric|analytic|chart|report|dashboard)\w*/, "chart-line"],
  [/\b(money|price|cost|budget|invoice|pay|finance|bank)\w*/, "dollar-sign"],
  [/\b(health|doctor|vet|medical|sleep|whoop)\w*/, "heart-pulse"],
  [/\b(workout|gym|fitness|run|exercise)\w*/, "dumbbell"],
  [/\b(food|recipe|cook|meal|restaurant)\w*/, "utensils"],
  [/\b(dog|pug|cat|pet)s?\b/, "paw"],
  [/\b(travel|flight|trip|hotel)\w*/, "plane"],
  [/\b(home|house|apartment)\w*/, "house"],
  [/\b(agent|subagent|bot)\w*/, "robot"],
  [/\b(terminal|shell|cli|script|bash)\w*/, "terminal"],
  [/\b(code|implement|build|feature|port)\w*/, "code"],
];

/**
 * A stable icon for a thread title without asking a model. Keywords decide
 * when one matches; otherwise the title hashes onto a small neutral set so
 * sibling rows still read apart.
 */
export function fallbackExowattThreadIcon(title: string): ExowattThreadIconName {
  const text = title.toLowerCase();
  for (const [pattern, icon] of KEYWORD_RULES) {
    if (pattern.test(text)) return icon;
  }
  const neutral: ReadonlyArray<ExowattThreadIconName> = [
    "cube",
    "bolt",
    "star",
    "compass",
    "lightbulb",
    "puzzle-piece",
    "leaf",
    "shapes",
  ];
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return neutral[Math.abs(hash) % neutral.length]!;
}

/** A thread's stored icon. `title` is the title it was picked for. */
export const ExowattThreadIcon = Schema.Struct({
  threadId: ThreadId,
  // A plain string on the wire so a newer server's icon still decodes; the
  // client falls back for names it does not draw.
  icon: Schema.String,
  title: Schema.String,
  source: Schema.Literals(["generated", "fallback"]),
  updatedAt: IsoDateTime,
});
export type ExowattThreadIcon = typeof ExowattThreadIcon.Type;

/**
 * The icon feed: every stored icon once on subscribe, then each change as it
 * lands. Clients fold it into a map keyed by thread id.
 */
export const ExowattThreadIconsStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    icons: Schema.Array(ExowattThreadIcon),
  }),
  Schema.Struct({
    type: Schema.Literal("upsert"),
    icons: Schema.Array(ExowattThreadIcon),
  }),
  Schema.Struct({
    type: Schema.Literal("remove"),
    threadIds: Schema.Array(ThreadId),
  }),
]);
export type ExowattThreadIconsStreamEvent = typeof ExowattThreadIconsStreamEvent.Type;

export const ExowattThreadIconsSubscribeInput = Schema.Struct({});
export type ExowattThreadIconsSubscribeInput = typeof ExowattThreadIconsSubscribeInput.Type;

export class ExowattThreadIconsError extends Schema.TaggedError<ExowattThreadIconsError>()(
  "ExowattThreadIconsError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Thread icons ${this.operation} failed: ${this.reason}`;
  }
}
