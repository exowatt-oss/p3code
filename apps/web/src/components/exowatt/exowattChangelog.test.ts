import { describe, expect, it } from "vite-plus/test";

import {
  compareExowattVersions,
  EXOWATT_CHANGELOG,
  EXOWATT_CHANGELOG_NEXT_VERSION,
  exowattBuildLabel,
  parseExowattVersion,
  resolveExowattChangelogView,
  type ExowattChangelogRelease,
} from "./exowattChangelog";

const releases: ReadonlyArray<ExowattChangelogRelease> = [
  { version: EXOWATT_CHANGELOG_NEXT_VERSION, upstream: "0.0.38", items: ["This page."] },
  {
    version: "0.0.38-exowatt.23",
    date: "2026-09-03",
    upstream: "0.0.38",
    items: ["Model notices."],
  },
  { version: "0.0.38-exowatt.21", date: "2026-09-02", upstream: "0.0.38", items: ["Rebase."] },
  {
    version: "0.0.37-exowatt.20",
    date: "2026-09-02",
    upstream: "0.0.37",
    items: ["RPC tolerance."],
  },
];

describe("exowattChangelog", () => {
  it("orders exowatt builds by upstream then build number", () => {
    expect(parseExowattVersion("v0.0.38-exowatt.23")).toEqual([0, 0, 38, 23]);
    expect(parseExowattVersion("0.0.38")).toEqual([0, 0, 38, -1]);
    expect(parseExowattVersion("dev")).toBeNull();
    expect(compareExowattVersions("0.0.38-exowatt.23", "0.0.38-exowatt.21")).toBeGreaterThan(0);
    expect(compareExowattVersions("0.0.38-exowatt.2", "0.0.37-exowatt.20")).toBeGreaterThan(0);
    expect(compareExowattVersions("0.0.38", "0.0.38-exowatt.0")).toBeLessThan(0);
    expect(exowattBuildLabel("0.0.38-exowatt.23")).toBe("exowatt.23");
    expect(exowattBuildLabel("0.0.38")).toBe("0.0.38");
  });

  it("marks the running release current and leaves the next entry unreleased", () => {
    const view = resolveExowattChangelogView(releases, "0.0.38-exowatt.23", false);
    expect(view.map((entry) => [entry.versionLabel, entry.current, entry.unreleased])).toEqual([
      ["Unreleased", false, true],
      ["0.0.38-exowatt.23", true, false],
      ["0.0.38-exowatt.21", false, false],
      ["0.0.37-exowatt.20", false, false],
    ]);
    expect(view.map((entry) => entry.upstreamBump)).toEqual([false, false, true, false]);
  });

  it("labels the next entry with the running build once that build is newer than every numbered entry", () => {
    const [next, latest] = resolveExowattChangelogView(releases, "v0.0.38-exowatt.25", false);
    expect(next).toMatchObject({
      versionLabel: "0.0.38-exowatt.25",
      buildLabel: "exowatt.25",
      current: true,
      unreleased: false,
    });
    expect(latest?.current).toBe(false);
  });

  it("never lets a dev build claim a release", () => {
    const view = resolveExowattChangelogView(releases, "0.0.38", true);
    expect(view.some((entry) => entry.current)).toBe(false);
    expect(view[0]).toMatchObject({
      versionLabel: "Unreleased",
      buildLabel: "Next",
      unreleased: true,
    });
  });

  it("hides an empty next entry from the rendered feed", () => {
    const view = resolveExowattChangelogView(
      [
        { version: EXOWATT_CHANGELOG_NEXT_VERSION, upstream: "0.0.40", items: [] },
        { version: "0.0.40-exowatt.52", date: "2026-09-12", upstream: "0.0.40", items: ["Base."] },
        { version: "0.0.38-exowatt.51", date: "2026-09-12", upstream: "0.0.38", items: ["Older."] },
      ],
      "0.0.40-exowatt.52",
      false,
    );
    expect(view.map((entry) => entry.release.version)).toEqual([
      "0.0.40-exowatt.52",
      "0.0.38-exowatt.51",
    ]);
    expect(view[0]?.upstreamBump).toBe(true);
  });

  it("keeps the shipped feed newest-first with one next entry on top", () => {
    expect(EXOWATT_CHANGELOG[0]?.version).toBe(EXOWATT_CHANGELOG_NEXT_VERSION);
    // `next` may carry bullets between releases; the release pipeline empties it.
    expect(Array.isArray(EXOWATT_CHANGELOG[0]?.items)).toBe(true);
    expect(EXOWATT_CHANGELOG[0]?.date).toBeUndefined();
    expect(EXOWATT_CHANGELOG[0]?.upstream).toBe(EXOWATT_CHANGELOG[1]?.upstream);
    const numbered = EXOWATT_CHANGELOG.slice(1).map((release) => release.version);
    expect(numbered.filter((version) => version === EXOWATT_CHANGELOG_NEXT_VERSION)).toEqual([]);
    for (let index = 1; index < numbered.length; index += 1) {
      expect(compareExowattVersions(numbered[index - 1]!, numbered[index]!)).toBeGreaterThan(0);
    }
    for (const release of EXOWATT_CHANGELOG) {
      if (release.version === EXOWATT_CHANGELOG_NEXT_VERSION) {
        expect(release.date).toBeUndefined();
      } else {
        expect(release.items.length).toBeGreaterThan(0);
        expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      }
    }
  });
});
