/**
 * Exowatt: `ProviderDriver` for Phi on upstream's Pi stack (flavored adapter, probe, text generation).
 * Phi's own part is distribution (versions feed and installer). Phi state lives in `~/.pi/agent`, so
 * continuation identity uses the default instance grouping.
 */
import { PhiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  discoverPiCommandsForCwd,
  enrichPiSnapshot,
  makePiTextGeneration,
  PI_PROVIDER_FLAVOR,
  type PiProviderFlavor,
} from "@t3tools/provider-pi/server";

import {
  PhiAdapterV2Driver,
  type PhiAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/PhiAdapterV2.ts";
import {
  DEFAULT_PHI_BINARY,
  fetchPhiLatestVersion,
  isRecommendedPhiVersion,
  isSupportedPhiVersion,
  MINIMUM_PHI_VERSION,
  parsePhiCliVersion,
  PHI_DISTRIBUTION,
  RECOMMENDED_PHI_VERSION,
} from "../phi/PhiRpc.ts";

const decodePhiSettings = Schema.decodeSync(PhiSettings);
const DRIVER_KIND = ProviderDriverKind.make("phi");

export const PHI_PROVIDER_FLAVOR: PiProviderFlavor = {
  label: "Phi",
  presentation: { ...PI_PROVIDER_FLAVOR.presentation, displayName: "Phi" },
  defaultBinary: DEFAULT_PHI_BINARY,
  missingBinaryMessage: `Phi CLI (\`phi\`) is not installed or not on PATH.${
    PHI_DISTRIBUTION.installerUrl === undefined
      ? ""
      : ` Install with \`curl -fsSL ${PHI_DISTRIBUTION.installerUrl} | sh\`.`
  }`,
  minimumVersion: MINIMUM_PHI_VERSION,
  parseVersion: parsePhiCliVersion,
  isSupportedVersion: isSupportedPhiVersion,
  noModelsMessage:
    "Phi has no usable models. Run `phi` in a terminal and use /login, or configure an API key in ~/.pi/agent.",
};

// Latest version: the versions feed. Updates re-run the installer (the binary refuses
// `phi update --self`); download first so a failed download errors instead of `sh` exiting 0 on an
// empty pipe. `uname -m` lies under Rosetta, so a Mac that can run arm64 runs it as arm64.
const phiUpdateScript = (installerUrl: string) =>
  [
    "set -e",
    'installer="$(mktemp)"',
    `curl -fsSL "${installerUrl}" -o "$installer"`,
    'if [ "$(uname -s)" = Darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch -arm64 sh "$installer"; else sh "$installer"; fi',
    'rm -f "$installer"',
  ].join("; ");

const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("PhiDriver.resolveMaintenance")(function* (context) {
    const manualOnly = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });
    const installerUrl = PHI_DISTRIBUTION.installerUrl;
    if (context === null || context.platform === "win32" || installerUrl === undefined) {
      return manualOnly;
    }

    // The curl installer owns ~/.local/share/phi/phi (or PHI_INSTALL_DIR/phi)
    // and stamps the install with phi-version.json. Do not offer an update
    // for an arbitrary binaryPath: re-running the installer would update a
    // different executable than the one the user selected.
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = context.env.HOME?.trim();
    const configuredInstallDir = context.env.PHI_INSTALL_DIR?.trim();
    const installDir =
      configuredInstallDir || (home ? path.join(home, ".local", "share", "phi") : null);
    if (installDir === null) return manualOnly;
    const installerBinary = path.join(installDir, "phi");
    if (normalizeCommandPath(context.realCommandPath) !== normalizeCommandPath(installerBinary)) {
      return manualOnly;
    }
    const hasInstallerStamp = yield* fileSystem
      .exists(path.join(installDir, "phi-version.json"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasInstallerStamp) return manualOnly;

    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
      updateExecutable: "sh",
      updateArgs: ["-c", phiUpdateScript(installerUrl)],
      updateLockKey: "phi",
      updateCommand: `curl -fsSL ${installerUrl} | sh`,
      platform: context.platform,
      env: { ...context.env, PHI_INSTALL_DIR: installDir },
    });
  }),
};

/** Phi is not on npm: its latest version only ever comes from the versions feed, if there is one. */
const withPhiLatestVersion =
  (httpClient: HttpClient.HttpClient) =>
  (capabilities: ProviderMaintenanceCapabilities): ProviderMaintenanceCapabilities => {
    const manifestUrl = PHI_DISTRIBUTION.versionsManifestUrl;
    if (manifestUrl === undefined) return { ...capabilities, latestVersion: null };
    return {
      ...capabilities,
      latestVersion: null,
      latestVersionCacheKey: manifestUrl,
      lookupLatestVersion: fetchPhiLatestVersion(manifestUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    };
  };

/**
 * Below RECOMMENDED_PHI_VERSION Phi works but persists every thread's model
 * pick as the user's default, so a ready snapshot says to update.
 */
export function withPhiRecommendation(snapshot: ServerProviderDraft): ServerProviderDraft {
  if (snapshot.status !== "ready" || snapshot.version === null) return snapshot;
  if (isRecommendedPhiVersion(snapshot.version) || snapshot.message) return snapshot;
  return {
    ...snapshot,
    message: `Phi ${snapshot.version} works, but update to ${RECOMMENDED_PHI_VERSION} or newer so model picks stay per thread.`,
  };
}

export type PhiDriverEnv =
  | PhiAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const PhiDriver: ProviderDriver<PhiSettings, PhiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Phi",
    supportsMultipleInstances: true,
  },
  configSchema: PhiSettings,
  defaultConfig: (): PhiSettings => decodePhiSettings({}),
  create: Effect.fn("PhiDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    const { cwd } = host.paths;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies PhiSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.map(withPhiLatestVersion(httpClient)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    const orchestrationAdapter = yield* PhiAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Phi orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makePiTextGeneration(effectiveConfig, processEnv);

    const checkProvider = checkPiProviderStatus(
      effectiveConfig,
      processEnv,
      cwd,
      PHI_PROVIDER_FLAVOR,
    ).pipe(
      Effect.map((snapshot) => stampIdentity(withPhiRecommendation(snapshot))),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PhiSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialPiProviderSnapshot(settings.provider, PHI_PROVIDER_FLAVOR).pipe(
          Effect.map(stampIdentity),
        ),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichPiSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Phi snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (workspaceCwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverPiCommandsForCwd(
                effectiveConfig,
                processEnv,
                workspaceCwd,
                PHI_PROVIDER_FLAVOR,
              ).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: "Failed to discover Phi workspace commands.",
                      cause,
                    }),
                ),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, commands]) => ({
                ...machineSnapshot,
                ...commands,
                slashCommandsPending: false,
              })),
            ),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
