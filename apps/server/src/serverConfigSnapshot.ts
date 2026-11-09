/**
 * exowatt: the `ServerConfig` payload for the `server_config_get` MCP tool. It mirrors
 * `loadServerConfig` in ws.ts (the WebSocket `server.getConfig` RPC) for a client that reads
 * secret references and wants every discovery resolved; keep the two in step when upstream
 * adds a capability flag. Dependencies are passed in to keep the effect requirement-free.
 */
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import type * as ServerConfig from "./config.ts";
import type * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import type * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import type * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import type * as Keybindings from "./keybindings.ts";
import type * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import type * as ExternalLauncher from "./process/externalLauncher.ts";
import type * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import type * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";
import { resolveOpenDiscoveryForConfig } from "./ws.ts";

export interface ServerConfigSnapshotServices {
  readonly keybindings: Keybindings.Keybindings["Service"];
  readonly providerRegistry: ProviderRegistry.ProviderRegistry["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly serverEnvironment: ServerEnvironment.ServerEnvironment["Service"];
  readonly serverAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly externalLauncher: ExternalLauncher.ExternalLauncher["Service"];
  readonly remoteOpenTargets: RemoteOpenTargets.RemoteOpenTargets["Service"];
  readonly directEndpoints: DirectEndpoints.DirectEndpoints["Service"];
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly managedFolders: ManagedProjectFolders.ManagedProjectFolders["Service"];
  readonly eventLoopMonitor: Context.Service.Shape<typeof EventLoopMonitor.EventLoopMonitor>;
}

export const loadServerConfigSnapshot = Effect.fn("loadServerConfigSnapshot")(function* (
  services: ServerConfigSnapshotServices,
) {
  const {
    keybindings,
    providerRegistry,
    serverSettings,
    serverEnvironment,
    serverAuth,
    externalLauncher,
    remoteOpenTargets,
    directEndpoints,
    config,
    managedFolders,
    eventLoopMonitor,
  } = services;
  const keybindingsConfig = yield* keybindings.loadConfigState;
  const providers = yield* providerRegistry.getProviders;
  const settings = ServerSettings.redactServerSettingsForClient(yield* serverSettings.getSettings, {
    secretReferences: true,
  });
  const environment = yield* serverEnvironment.getDescriptor;
  const auth = yield* serverAuth.getDescriptor();
  const scratchWorkspaceRoot = yield* managedFolders.scratchRoot;
  const lastEventLoopStall = yield* eventLoopMonitor.latestNoticeableStall;
  const discovery = yield* resolveOpenDiscoveryForConfig({
    editors: externalLauncher.resolveAvailableEditors(),
    fileManagerRevealKind: externalLauncher.resolveFileManagerRevealKind(),
    remoteOpenTargets: remoteOpenTargets.resolveTargets(),
    directEndpoints: directEndpoints.resolve(),
  });

  return {
    environment,
    auth,
    cwd: config.cwd,
    keybindingsConfigPath: config.keybindingsConfigPath,
    keybindings: keybindingsConfig.keybindings,
    issues: keybindingsConfig.issues,
    providers,
    ...discovery,
    observability: {
      logsDirectoryPath: config.logsDir,
      localTracingEnabled: true,
      ...(config.otlpTracesUrl !== undefined
        ? {
            otlpTracesUrl: config.otlpTracesUrl,
            otlpTracesSource: config.otlpTracesSource,
            otlpTracesVariable: config.otlpTracesVariable,
          }
        : {}),
      otlpTracesEnabled: config.otlpTracesUrl !== undefined,
      ...(config.otlpMetricsUrl !== undefined
        ? {
            otlpMetricsUrl: config.otlpMetricsUrl,
            otlpMetricsSource: config.otlpMetricsSource,
            otlpMetricsVariable: config.otlpMetricsVariable,
          }
        : {}),
      otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
      ...(config.otlpLogsUrl !== undefined
        ? {
            otlpLogsUrl: config.otlpLogsUrl,
            otlpLogsSource: config.otlpLogsSource,
            otlpLogsVariable: config.otlpLogsVariable,
          }
        : {}),
      otlpLogsEnabled: config.otlpLogsUrl !== undefined,
    },
    settings,
    ...(serverSettings.managedPolicy === undefined
      ? {}
      : { managedPolicy: serverSettings.managedPolicy }),
    shellResumeCompletionMarker: true,
    shellThreadFamilies: true,
    shellOlderSettled: true,
    threadResumeCompletionMarker: true,
    threadSnapshotPagination: true,
    threadFind: true,
    threadFindProgressive: true,
    secretProviderSettings: true,
    secretReferences: true,
    secretRequestReferences: true,
    ...Option.match(scratchWorkspaceRoot, {
      onNone: () => ({}),
      onSome: (root) => ({ scratchWorkspaceRoot: root }),
    }),
    newProjectsRoot: managedFolders.namedProjectsRoot,
    ...(lastEventLoopStall === undefined ? {} : { lastEventLoopStall }),
  };
});
