import type {
  ClientSettings,
  ExowattAccent,
  ExowattStatusLightBlink,
} from "@t3tools/contracts/settings";

/** A picked accent colour; `"default"` (the default) keeps upstream's own colours. */
export type ExowattAccentPresetId = Exclude<ExowattAccent, "default">;

export interface ExowattAccentPreset {
  readonly id: ExowattAccentPresetId;
  readonly label: string;
  readonly color: string;
  readonly darkColor: string;
  /** Text on a solid fill of the accent: at least 4.5:1 at rest and under the 85% hover fill. */
  readonly foreground: string;
  readonly darkForeground: string;
}

// Opt-in only: the default accent is "default", i.e. upstream's own colours.
// White on these fills is 3.2–4.2:1, so they carry near-black ink tinted to their hue. In dark
// mode amber, ocean and orchid lift to sunrise's lightness so the ink still passes on hover.
export const EXOWATT_ACCENT_PRESETS: ReadonlyArray<ExowattAccentPreset> = [
  {
    id: "sunrise",
    label: "Sunrise",
    color: "oklch(0.67 0.2 45)",
    darkColor: "oklch(0.67 0.2 45)",
    foreground: "oklch(0.15 0.02 45)",
    darkForeground: "oklch(0.15 0.02 45)",
  },
  {
    id: "amber",
    label: "Amber",
    color: "oklch(0.59 0.16 75)",
    darkColor: "oklch(0.68 0.16 75)",
    foreground: "oklch(0.15 0.02 75)",
    darkForeground: "oklch(0.15 0.02 75)",
  },
  {
    id: "ocean",
    label: "Ocean",
    color: "oklch(0.61 0.18 245)",
    darkColor: "oklch(0.68 0.18 245)",
    foreground: "oklch(0.15 0.02 245)",
    darkForeground: "oklch(0.15 0.02 245)",
  },
  {
    id: "orchid",
    label: "Orchid",
    color: "oklch(0.62 0.2 315)",
    darkColor: "oklch(0.68 0.2 315)",
    foreground: "oklch(0.15 0.02 315)",
    darkForeground: "oklch(0.15 0.02 315)",
  },
];

// Blueprint blue sampled from assets/dev/blueprint-macos-1024.png (body
// #197dc5 ≈ oklch(0.57 0.14 247)). The dev build pins the accent here so dev
// and production are told apart at a glance whatever the user picked; the
// light/dark appearance choice itself is untouched.
export const EXOWATT_DEV_ACCENT = {
  id: "blueprint",
  label: "Blueprint",
  light: "oklch(0.52 0.15 250)",
  dark: "oklch(0.7 0.13 235)",
  lightForeground: "oklch(1 0 0)",
  darkForeground: "oklch(0.15 0.02 235)",
} as const;

export interface ExowattAccentResolution {
  readonly id: ExowattAccentPresetId | typeof EXOWATT_DEV_ACCENT.id;
  readonly color: string;
  readonly darkColor: string;
  readonly foreground: string;
  readonly darkForeground: string;
  readonly forced: boolean;
}

/** `null` means no P3 accent: upstream's `--primary` and friends stay in charge. */
export function resolveExowattAccent(
  settings: Pick<ExowattCustomizationSettings, "exowatt.accent">,
  options: { readonly isDevBuild: boolean },
): ExowattAccentResolution | null {
  if (options.isDevBuild) {
    return {
      id: EXOWATT_DEV_ACCENT.id,
      color: EXOWATT_DEV_ACCENT.light,
      darkColor: EXOWATT_DEV_ACCENT.dark,
      foreground: EXOWATT_DEV_ACCENT.lightForeground,
      darkForeground: EXOWATT_DEV_ACCENT.darkForeground,
      forced: true,
    };
  }
  const preset = EXOWATT_ACCENT_PRESETS.find(
    (candidate) => candidate.id === settings["exowatt.accent"],
  );
  if (!preset) return null;
  return {
    id: preset.id,
    color: preset.color,
    darkColor: preset.darkColor,
    foreground: preset.foreground,
    darkForeground: preset.darkForeground,
    forced: false,
  };
}

const STATUS_LIGHT_DURATION: Record<ExowattStatusLightBlink, string> = {
  off: "0s",
  subtle: "3.4s",
  standard: "2s",
  strong: "1.15s",
};

export type ExowattCustomizationSettings = Pick<
  ClientSettings,
  | "exowatt.accent"
  | "exowatt.sidebarDensity"
  | "exowatt.sidebarGroupByProject"
  | "exowatt.sidebarProjectSort"
  | "exowatt.workspaceStateCallouts"
  | "exowatt.sidebarNestDispatched"
  | "exowatt.sidebarSort"
  | "exowatt.sidebarSortReversed"
  | "exowatt.statusLightBlink"
>;

// Theme deliberately has no `exowatt.*` key: the Customize page reads and
// writes the upstream appearance preference through useTheme, so Settings >
// Appearance and Customize can never disagree.
export function selectExowattCustomization(settings: ClientSettings): ExowattCustomizationSettings {
  return {
    "exowatt.accent": settings["exowatt.accent"],
    "exowatt.sidebarDensity": settings["exowatt.sidebarDensity"],
    "exowatt.sidebarGroupByProject": settings["exowatt.sidebarGroupByProject"],
    "exowatt.sidebarProjectSort": settings["exowatt.sidebarProjectSort"],
    "exowatt.workspaceStateCallouts": settings["exowatt.workspaceStateCallouts"],
    "exowatt.sidebarNestDispatched": settings["exowatt.sidebarNestDispatched"],
    "exowatt.sidebarSort": settings["exowatt.sidebarSort"],
    "exowatt.sidebarSortReversed": settings["exowatt.sidebarSortReversed"],
    "exowatt.statusLightBlink": settings["exowatt.statusLightBlink"],
  };
}

export function applyExowattCustomization(
  root: HTMLElement,
  settings: ExowattCustomizationSettings,
  options: { readonly isDevBuild: boolean } = { isDevBuild: false },
): void {
  const accent = resolveExowattAccent(settings, options);
  const blink = settings["exowatt.statusLightBlink"];

  // Every accent rule is keyed on data-exowatt-accent, so dropping it restores upstream colours.
  if (accent) {
    root.dataset.exowattAccent = accent.id;
    root.style.setProperty("--exowatt-accent-light", accent.color);
    root.style.setProperty("--exowatt-accent-dark", accent.darkColor);
    root.style.setProperty("--exowatt-accent-foreground-light", accent.foreground);
    root.style.setProperty("--exowatt-accent-foreground-dark", accent.darkForeground);
  } else {
    delete root.dataset.exowattAccent;
  }
  root.dataset.exowattDevBuild = accent?.forced ? "on" : "off";
  root.dataset.exowattSidebarDensity = settings["exowatt.sidebarDensity"];
  root.dataset.exowattSidebarSort = settings["exowatt.sidebarSort"];
  root.dataset.exowattStatusLightBlink = blink;
  root.style.setProperty("--exowatt-status-light-duration", STATUS_LIGHT_DURATION[blink]);
}

export const EXOWATT_CUSTOMIZATION_STYLES = `
html[data-exowatt-accent] {
  --exowatt-accent: var(--exowatt-accent-light);
  --exowatt-accent-foreground: var(--exowatt-accent-foreground-light);
}

html[data-exowatt-accent].dark {
  --exowatt-accent: var(--exowatt-accent-dark);
  --exowatt-accent-foreground: var(--exowatt-accent-foreground-dark);
}

/* The accent colours the default look only: a chosen named or imported theme keeps its own
   action colour. (0,2,1) outranks upstream's :root and its generated dark variant (0,2,0). */
html[data-exowatt-accent]:not([data-theme-id]) {
  --primary: var(--exowatt-accent);
  --primary-foreground: var(--exowatt-accent-foreground);
  --ring: var(--exowatt-accent);
  --message-action: var(--exowatt-accent);
  --message-action-foreground: var(--exowatt-accent-foreground);
  --update: var(--exowatt-accent);
}

/* Dev build: blueprint wins over every theme, so dev is never mistaken for production. */
html[data-exowatt-dev-build="on"] {
  --primary: var(--exowatt-accent) !important;
  --primary-foreground: var(--exowatt-accent-foreground) !important;
  --ring: var(--exowatt-accent) !important;
  --message-action: var(--exowatt-accent) !important;
  --message-action-foreground: var(--exowatt-accent-foreground) !important;
  --update: var(--exowatt-accent) !important;
}

/* Dev build: sidebar and titlebar surfaces lean a few percent toward the
   blueprint accent on top of whatever theme is active. Composed from the
   live tokens so custom themes and both appearances keep their own base. */
html[data-exowatt-dev-build="on"] [data-app-sidebar],
html[data-exowatt-dev-build="on"] [data-app-sidebar] [data-slot="sidebar-inner"] {
  background-color: color-mix(in oklab, var(--sidebar) 95%, var(--exowatt-accent));
}

html[data-exowatt-dev-build="on"] [data-app-sidebar] [data-slot="sidebar-header"] {
  background-color: color-mix(in oklab, var(--sidebar) 91%, var(--exowatt-accent));
}

/* Status-light blink drives what shows running state: upstream's pulsing status dots and terminal
   icons in the sidebar, and P3 thread-icon dots wherever they render. Upstream's pulse is
   motion-safe:, so with Reduce Motion on there is no animation for these rules to touch. */
html[data-exowatt-status-light-blink="off"]
  :is([data-app-sidebar] [class*="animate-status-pulse"], [data-status-light="running"]) {
  animation: none !important;
}

html[data-exowatt-status-light-blink]:not([data-exowatt-status-light-blink="off"])
  :is([data-app-sidebar] [class*="animate-status-pulse"], [data-status-light="running"]) {
  animation-duration: var(--exowatt-status-light-duration) !important;
}

html[data-exowatt-status-light-blink="strong"]
  :is([data-app-sidebar] [class*="animate-status-pulse"], [data-status-light="running"]) {
  filter: saturate(1.2);
}

html[data-exowatt-sidebar-density="compact"] {
  --sidebar-content-inset: 0.25rem;
  --sidebar-control-gap: 0.375rem;
  --sidebar-row-content-inset: 0.5rem;
}

html[data-exowatt-sidebar-density="compact"]
  [data-sidebar="menu-button"][data-size="default"] {
  height: 1.75rem;
  padding-block: 0.25rem;
}

html[data-exowatt-sidebar-density="compact"] [data-sidebar="menu"] {
  gap: 0.125rem;
}

/* Compact rows use a single 28px line, including live and pinned threads.
   Retain a one-pixel list gap and trim project/shelf header spacing. */
html[data-exowatt-sidebar-density="compact"] [data-app-sidebar] [data-testid="sidebar-row-slim"] {
  height: 1.75rem;
  gap: 0.5rem;
}

html[data-exowatt-sidebar-density="compact"] [data-app-sidebar] [data-thread-item] {
  contain-intrinsic-size: auto 1.75rem;
}

html[data-exowatt-sidebar-density="compact"] [data-app-sidebar] [data-exowatt-project-shelf] {
  margin-top: 0.25rem;
}

html[data-exowatt-sidebar-density="compact"] [data-app-sidebar] [data-exowatt-sidebar-project-section] button[draggable] {
  margin-top: 0.375rem;
}

html[data-exowatt-sidebar-density="compact"] [data-app-sidebar] [data-exowatt-compact-row] [data-exowatt-relationship-chip] {
  max-width: 4rem;
}

html[data-exowatt-sidebar-density="compact"] [data-app-sidebar] [data-testid$="-shelf-toggle"],
html[data-exowatt-sidebar-density="compact"]
  [data-app-sidebar]
  [data-testid="exowatt-sidebar-project-section-toggle"] {
  margin-top: 0.375rem;
  margin-bottom: 0.125rem;
}

html[data-exowatt-sidebar-density="compact"] [data-app-sidebar] [data-testid="sidebar-pinned-divider"] {
  margin-block: 0.25rem;
}
`;
