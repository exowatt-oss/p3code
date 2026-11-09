/** User-visible release notes for P3 Code. */

export const EXOWATT_CHANGELOG_NEXT_VERSION = "next";
export const EXOWATT_CHANGELOG_ROUTE = "/changelog" as const;
export const EXOWATT_CHANGELOG_LABEL = "What's new";

export interface ExowattChangelogRelease {
  /** a release version, or `next` for the entry the next release will carry. */
  readonly version: string;
  /** ISO date the release was published (`YYYY-MM-DD`); omitted for `next`. */
  readonly date?: string;
  /** Upstream T3 Code version the build is based on. */
  readonly upstream: string;
  /** Optional one-line theme for the release. */
  readonly title?: string;
  readonly items: ReadonlyArray<string>;
}

export const EXOWATT_CHANGELOG: ReadonlyArray<ExowattChangelogRelease> = [
  { version: EXOWATT_CHANGELOG_NEXT_VERSION, upstream: "0.1.7", items: [] },
  { version: "0.1.7", date: "2026-11-08", upstream: "0.1.7", items: ["P3 Code source fork of T3 Code, with optional Phi and Feads integrations. Build from source; no upstream installers or mobile-store apps distribute this fork."] },
];

export interface ExowattChangelogEntryView {
  readonly release: ExowattChangelogRelease;
  /** `next` resolved to a version label, or `Unreleased` while no build carries it. */
  readonly versionLabel: string;
  /** `exowatt.23` style short label for the heading. */
  readonly buildLabel: string;
  /** This entry describes the running build. */
  readonly current: boolean;
  /** The `next` entry while no released build carries it. */
  readonly unreleased: boolean;
  /** First entry on a new upstream base, relative to the (older) entry below it. */
  readonly upstreamBump: boolean;
}

export function normalizeExowattVersion(version: string): string {
  return version.trim().replace(/^v/u, "");
}

/** `0.0.38-exowatt.23` → `[0, 0, 38, 23]`; a version without the suffix sorts before every exowatt build of that upstream. */
export function parseExowattVersion(version: string): ReadonlyArray<number> | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-exowatt\.(\d+))?/u.exec(normalizeExowattVersion(version));
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? -1 : Number(match[4]),
  ];
}

export function compareExowattVersions(a: string, b: string): number {
  const left = parseExowattVersion(a);
  const right = parseExowattVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 4; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function exowattBuildLabel(version: string): string {
  const normalized = normalizeExowattVersion(version);
  const suffix = /-exowatt\.(\d+)$/u.exec(normalized)?.[1];
  return suffix === undefined ? normalized : `exowatt.${suffix}`;
}

export function formatExowattChangelogDate(date: string | undefined): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Resolve the feed for the running build: which entry is current, and what the
 * `next` entry should be called. A dev build never claims a numbered release.
 */
export function resolveExowattChangelogView(
  releases: ReadonlyArray<ExowattChangelogRelease>,
  appVersion: string,
  isDevBuild: boolean,
): ReadonlyArray<ExowattChangelogEntryView> {
  const runningVersion = isDevBuild ? null : normalizeExowattVersion(appVersion);
  const latestNumbered = releases.find(
    (release) => release.version !== EXOWATT_CHANGELOG_NEXT_VERSION,
  );
  const runningIsNewerThanLatest =
    runningVersion !== null &&
    parseExowattVersion(runningVersion) !== null &&
    (latestNumbered === undefined ||
      compareExowattVersions(runningVersion, latestNumbered.version) > 0);

  const visibleReleases = releases.filter(
    (release) => release.version !== EXOWATT_CHANGELOG_NEXT_VERSION || release.items.length > 0,
  );
  return visibleReleases.map((release, index) => {
    const isNext = release.version === EXOWATT_CHANGELOG_NEXT_VERSION;
    const resolvedVersion =
      isNext && runningIsNewerThanLatest && runningVersion !== null ? runningVersion : null;
    const versionLabel = isNext
      ? (resolvedVersion ?? "Unreleased")
      : normalizeExowattVersion(release.version);
    const current =
      runningVersion !== null &&
      (isNext
        ? resolvedVersion !== null
        : compareExowattVersions(release.version, runningVersion) === 0);
    const previous = visibleReleases[index + 1];
    return {
      release,
      versionLabel,
      buildLabel: isNext && resolvedVersion === null ? "Next" : exowattBuildLabel(versionLabel),
      current,
      unreleased: isNext && resolvedVersion === null,
      upstreamBump: previous !== undefined && previous.upstream !== release.upstream,
    };
  });
}
