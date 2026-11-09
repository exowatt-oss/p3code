/**
 * Exowatt: Phi's version policy and distribution endpoints (transport and adapter are upstream's Pi
 * stack). Keep each version literal below a plain string literal on its own line: release tooling
 * reads them by name.
 */
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * Phi's distribution (it is not on npm): the versions feed phi's `/upgrade` reads and the POSIX-sh
 * installer that updates a standalone phi. Unset, P3 runs whatever `phi` is installed but offers
 * no update check and no one-click install.
 */
export interface PhiDistribution {
  readonly versionsManifestUrl: string | undefined;
  readonly installerUrl: string | undefined;
}
export const PHI_DISTRIBUTION: PhiDistribution = {
  // exowatt: Exowatt's Phi builds and their versions feed.
  versionsManifestUrl: undefined,
  installerUrl: undefined,
};
export const DEFAULT_PHI_BINARY = "phi";

const PhiVersionsManifest = Schema.Struct({
  latest: Schema.optional(Schema.Struct({ version: Schema.optional(Schema.String) })),
});

/** The newest Phi on a versions feed (`{ latest: { version } }`), or null when it cannot be read. */
export const fetchPhiLatestVersion = Effect.fn("fetchPhiLatestVersion")(function* (
  manifestUrl: string,
) {
  const client = yield* HttpClient.HttpClient;
  // The deadline covers the body too: headers can arrive before the JSON stalls.
  const manifest = yield* client.get(manifestUrl).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(PhiVersionsManifest)),
    Effect.timeoutOption("4 seconds"),
    Effect.orElseSucceed(() => Option.none()),
  );
  const version = Option.isSome(manifest) ? manifest.value.latest?.version?.trim() : undefined;
  return version ? version : null;
});

/** Parses `phi --version`, keeping the `-exo.N` prerelease npm-style parsers drop. */
export function parsePhiCliVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

/**
 * The ONE place P3 states which Phi it needs. The provider probe refuses
 * anything older, so raise it only for a change the Pi transport cannot live
 * without.
 */
export const MINIMUM_PHI_VERSION = "0.83.0";
/** Public Phi baseline for optional CLI integration; the user supplies the binary. */
export const RECOMMENDED_PHI_VERSION = "0.83.0";

/**
 * Semver ranks every prerelease below its release, so against a release floor
 * ("0.83.0") the prerelease is dropped: 0.83.0-exo.1 satisfies 0.83.0. A floor
 * that names a prerelease itself ("0.83.0-exo.35") compares in full.
 */
function meetsPhiVersionFloor(version: string, floor: string): boolean {
  const candidate = floor.includes("-") ? version : (version.split("-")[0] ?? version);
  return compareSemverVersions(candidate, floor) >= 0;
}

export function isSupportedPhiVersion(version: string): boolean {
  return meetsPhiVersionFloor(version, MINIMUM_PHI_VERSION);
}

export function isRecommendedPhiVersion(version: string): boolean {
  return meetsPhiVersionFloor(version, RECOMMENDED_PHI_VERSION);
}
