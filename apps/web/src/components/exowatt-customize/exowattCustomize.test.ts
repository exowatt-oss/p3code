import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  applyExowattCustomization,
  EXOWATT_ACCENT_PRESETS,
  EXOWATT_CUSTOMIZATION_STYLES,
  EXOWATT_DEV_ACCENT,
  resolveExowattAccent,
  selectExowattCustomization,
} from "./exowattCustomize";

function relativeLuminance(oklch: string): number {
  const [l, c, h] = oklch.slice("oklch(".length, -1).split(" ").map(Number) as [
    number,
    number,
    number,
  ];
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const red = clamp(4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2]);
  const green = clamp(-1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2]);
  const blue = clamp(-0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left: string, right: string): number {
  const [light, dark] = [relativeLuminance(left), relativeLuminance(right)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

function cssBlock(selector: string): string {
  const start = EXOWATT_CUSTOMIZATION_STYLES.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return EXOWATT_CUSTOMIZATION_STYLES.slice(
    start,
    EXOWATT_CUSTOMIZATION_STYLES.indexOf("}", start),
  );
}

function createRootStub(): HTMLElement {
  const properties = new Map<string, string>();
  return {
    dataset: {},
    style: {
      getPropertyValue: (name: string) => properties.get(name) ?? "",
      setProperty: (name: string, value: string) => {
        properties.set(name, value);
      },
    },
  } as unknown as HTMLElement;
}

describe("applyExowattCustomization", () => {
  it("applies the persisted defaults as live document tokens", () => {
    const root = createRootStub();

    applyExowattCustomization(root, DEFAULT_CLIENT_SETTINGS);

    // The default accent keeps upstream's colours: no accent attribute, no accent tokens.
    expect(root.dataset.exowattAccent).toBeUndefined();
    expect(root.dataset.exowattSidebarDensity).toBe("compact");
    expect(root.dataset.exowattSidebarSort).toBe("activity");
    expect(root.dataset.exowattStatusLightBlink).toBe("standard");
    expect(root.style.getPropertyValue("--exowatt-accent-light")).toBe("");
    expect(root.dataset.exowattDevBuild).toBe("off");
  });

  it("maps disabled and compact choices onto shared integration selectors", () => {
    const root = createRootStub();

    applyExowattCustomization(root, {
      ...DEFAULT_CLIENT_SETTINGS,
      "exowatt.sidebarDensity": "compact",
      "exowatt.statusLightBlink": "off",
    });

    expect(root.dataset.exowattSidebarDensity).toBe("compact");
    expect(root.dataset.exowattStatusLightBlink).toBe("off");
    expect(EXOWATT_CUSTOMIZATION_STYLES).toContain('[data-status-light="running"]');
  });

  // Regression: a parallel `exowatt.theme` client setting used to override the
  // upstream appearance mode on every settings change, so Settings > Appearance
  // could never leave "System". Theme is owned by useTheme alone now.
  it("does not own or apply a theme preference", () => {
    const root = createRootStub();
    const selected = selectExowattCustomization({
      ...DEFAULT_CLIENT_SETTINGS,
      ...({ "exowatt.theme": "dark" } as Record<string, unknown>),
    } as typeof DEFAULT_CLIENT_SETTINGS);

    expect(Object.keys(selected)).not.toContain("exowatt.theme");
    expect(Object.keys(DEFAULT_CLIENT_SETTINGS)).not.toContain("exowatt.theme");

    applyExowattCustomization(root, DEFAULT_CLIENT_SETTINGS);
    expect(root.dataset.theme).toBeUndefined();
    expect(root.dataset.appearanceMode).toBeUndefined();
  });
});

describe("resolveExowattAccent", () => {
  it("leaves upstream's colours alone for the default accent", () => {
    expect(resolveExowattAccent({ "exowatt.accent": "default" }, { isDevBuild: false })).toBeNull();
    expect(DEFAULT_CLIENT_SETTINGS["exowatt.accent"]).toBe("default");
  });

  it("honours the user's accent in production builds", () => {
    const resolved = resolveExowattAccent({ "exowatt.accent": "orchid" }, { isDevBuild: false });
    const orchid = EXOWATT_ACCENT_PRESETS.find((preset) => preset.id === "orchid")!;

    expect(resolved).toEqual({
      id: "orchid",
      color: orchid.color,
      darkColor: orchid.darkColor,
      foreground: orchid.foreground,
      darkForeground: orchid.darkForeground,
      forced: false,
    });
  });

  it("forces the blueprint accent in dev builds regardless of the setting", () => {
    for (const preset of EXOWATT_ACCENT_PRESETS) {
      const resolved = resolveExowattAccent({ "exowatt.accent": preset.id }, { isDevBuild: true });
      expect(resolved).toEqual({
        id: "blueprint",
        color: EXOWATT_DEV_ACCENT.light,
        darkColor: EXOWATT_DEV_ACCENT.dark,
        foreground: EXOWATT_DEV_ACCENT.lightForeground,
        darkForeground: EXOWATT_DEV_ACCENT.darkForeground,
        forced: true,
      });
    }
    expect(EXOWATT_DEV_ACCENT.light).not.toBe(EXOWATT_DEV_ACCENT.dark);
  });

  it("marks the document as a dev build only when forced", () => {
    const prod = createRootStub();
    applyExowattCustomization(
      prod,
      { ...DEFAULT_CLIENT_SETTINGS, "exowatt.accent": "sunrise" },
      { isDevBuild: false },
    );
    expect(prod.dataset.exowattDevBuild).toBe("off");
    expect(prod.dataset.exowattAccent).toBe("sunrise");
    expect(prod.style.getPropertyValue("--exowatt-accent-light")).toBe(
      EXOWATT_ACCENT_PRESETS[0]!.color,
    );

    const dev = createRootStub();
    applyExowattCustomization(dev, DEFAULT_CLIENT_SETTINGS, { isDevBuild: true });
    expect(dev.dataset.exowattDevBuild).toBe("on");
    expect(dev.dataset.exowattAccent).toBe("blueprint");
    expect(dev.style.getPropertyValue("--exowatt-accent-light")).toBe(EXOWATT_DEV_ACCENT.light);
    expect(dev.style.getPropertyValue("--exowatt-accent-dark")).toBe(EXOWATT_DEV_ACCENT.dark);

    // The appearance (light/dark) stays with useTheme; only the accent is pinned.
    expect(dev.dataset.theme).toBeUndefined();
    expect(EXOWATT_CUSTOMIZATION_STYLES).toContain(
      'html[data-exowatt-dev-build="on"] [data-app-sidebar]',
    );
    expect(EXOWATT_CUSTOMIZATION_STYLES).toContain("html[data-exowatt-accent].dark");
  });
});

describe("accent tokens", () => {
  it("keeps text on every accent fill at 4.5:1 or better", () => {
    const fills = [
      ...EXOWATT_ACCENT_PRESETS.flatMap((preset) => [
        [preset.color, preset.foreground],
        [preset.darkColor, preset.darkForeground],
      ]),
      [EXOWATT_DEV_ACCENT.light, EXOWATT_DEV_ACCENT.lightForeground],
      [EXOWATT_DEV_ACCENT.dark, EXOWATT_DEV_ACCENT.darkForeground],
    ] as const;
    for (const [fill, text] of fills) {
      expect(contrastRatio(fill, text), `${text} on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // A chosen named or imported theme sets data-theme-id and keeps its own action colour;
  // only the dev build overrides it.
  it("yields to named themes in production and pins blueprint in dev", () => {
    const production = cssBlock("html[data-exowatt-accent]:not([data-theme-id])");
    expect(production).toContain("--primary: var(--exowatt-accent);");
    expect(production).toContain("--primary-foreground: var(--exowatt-accent-foreground);");
    expect(production).not.toContain("!important");

    const dev = cssBlock('html[data-exowatt-dev-build="on"]');
    expect(dev).toContain("--primary: var(--exowatt-accent) !important;");
    expect(dev).toContain("--primary-foreground: var(--exowatt-accent-foreground) !important;");
  });
});
