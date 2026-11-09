// Exowatt distro: handlers for the Settings MCP toolkit. Each wraps the same service call
// as the matching WebSocket RPC in ws.ts, so the MCP surface and the UI cannot diverge.
// `theme_set` has no RPC (`defaultTheme` is absent from `ServerSettingsPatch`), so it uses
// the settings-file write `t3 theme set` uses.
import {
  isProviderAvailable,
  type McpSettingsProvider,
  type McpSettingsProviderListResult,
  type McpSettingsProviderRefreshInput,
  type McpSettingsThemeListResult,
  type McpSettingsThemeSetInput,
  type McpSettingsThemeSetResult,
  type McpSettingsToolName,
  type McpSettingsUpdateInput,
  type ServerProvider,
  type ServerProviderUpdateInput,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
  SettingsToolError,
  EXOWATT_THREADS_MCP_CAPABILITY,
} from "@t3tools/contracts";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { resolvableThemeIdsFrom, writeDefaultTheme } from "../../../cli/theme.ts";
import * as ServerRuntimeConfig from "../../../config.ts";
import * as DirectEndpoints from "../../../environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "../../../environment/RemoteOpenTargets.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "../../../environmentTheme.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import * as ProviderMaintenanceRunner from "../../../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as EventLoopMonitor from "../../../observability/EventLoopMonitor.ts";
import { loadServerConfigSnapshot } from "../../../serverConfigSnapshot.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SettingsToolkit } from "./tools.ts";

type Deps =
  | McpInvocationContext.McpInvocationContext
  | ServerSettings.ServerSettingsService
  | Keybindings.Keybindings
  | ProviderRegistry.ProviderRegistry
  | ProviderMaintenanceRunner.ProviderMaintenanceRunner
  | EnvironmentTheme.EnvironmentThemeService
  | ServerRuntimeConfig.ServerConfig
  | ServerEnvironment.ServerEnvironment
  | EnvironmentAuth.EnvironmentAuth
  | ExternalLauncher.ExternalLauncher
  | RemoteOpenTargets.RemoteOpenTargets
  | FileSystem.FileSystem
  | Path.Path;

const toolError = (tool: McpSettingsToolName, detail: string) =>
  new SettingsToolError({ tool, detail });

/**
 * The one authorization rule of this toolkit. `environment-session` is a credential a
 * human minted with `t3 agent token` / `t3 auth session issue`; a `provider-session`
 * belongs to an agent P3 itself started, which must not change the environment it runs in.
 */
export const requireP3Access = Effect.fn("SettingsToolkit.requireP3Access")(function* (
  tool: McpSettingsToolName,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
    return yield* toolError(
      tool,
      `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability; settings tools need it.`,
    );
  }
  return invocation;
});

/**
 * The provider snapshot an agent needs to route work: identity, whether the
 * instance can run, and the models it accepts. The full snapshot also carries
 * slash commands, skills and palette metadata that only the UI reads.
 */
export function mcpSettingsProvider(provider: ServerProvider): McpSettingsProvider {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? null,
    enabled: provider.enabled,
    installed: provider.installed,
    available: isProviderAvailable(provider),
    version: provider.version,
    status: provider.status,
    auth: provider.auth,
    message: provider.message ?? null,
    checkedAt: provider.checkedAt,
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      isDefault: model.isDefault ?? false,
    })),
  };
}

const providerListResult = (
  providers: ReadonlyArray<ServerProvider>,
): McpSettingsProviderListResult => ({ providers: providers.map(mcpSettingsProvider) });

const settingsGet = Effect.fn("SettingsToolkit.settings_get")(function* (
  _input: Record<string, never>,
) {
  yield* requireP3Access("settings_get");
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError((cause) => toolError("settings_get", cause.message)),
  );
  return ServerSettings.redactServerSettingsForClient(settings, { secretReferences: true });
});

const settingsUpdate = Effect.fn("SettingsToolkit.settings_update")(function* (
  input: McpSettingsUpdateInput,
) {
  const invocation = yield* requireP3Access("settings_update");
  // Only a human-minted `t3 agent token` may change how far agents reach across environments,
  // in either direction: an in-app agent holding "command-center" must not widen its own reach.
  const agentCaller =
    invocation.environmentSession === undefined || invocation.environmentSession.peer === true;
  for (const key of ["exowattCrossEnvironmentAgentTools", "exowattPeerInbound"] as const) {
    if (input.patch[key] !== undefined && agentCaller) {
      return yield* toolError(
        "settings_update",
        `${key} cannot be changed by an agent; the user turns this on in Settings › Sharing & access.`,
      );
    }
  }
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const settings = yield* serverSettings
    .updateSettings(input.patch)
    .pipe(Effect.mapError((cause) => toolError("settings_update", cause.message)));
  return ServerSettings.redactServerSettingsForClient(settings, { secretReferences: true });
});

const serverConfigGet = Effect.fn("SettingsToolkit.server_config_get")(function* (
  _input: Record<string, never>,
) {
  yield* requireP3Access("server_config_get");
  return yield* loadServerConfigSnapshot({
    keybindings: yield* Keybindings.Keybindings,
    providerRegistry: yield* ProviderRegistry.ProviderRegistry,
    serverSettings: yield* ServerSettings.ServerSettingsService,
    serverEnvironment: yield* ServerEnvironment.ServerEnvironment,
    serverAuth: yield* EnvironmentAuth.EnvironmentAuth,
    externalLauncher: yield* ExternalLauncher.ExternalLauncher,
    remoteOpenTargets: yield* RemoteOpenTargets.RemoteOpenTargets,
    directEndpoints: yield* DirectEndpoints.DirectEndpoints,
    config: yield* ServerRuntimeConfig.ServerConfig,
    managedFolders: yield* ManagedProjectFolders.ManagedProjectFolders,
    eventLoopMonitor: yield* EventLoopMonitor.EventLoopMonitor,
  }).pipe(Effect.mapError((cause) => toolError("server_config_get", cause.message)));
});

const keybindingList = Effect.fn("SettingsToolkit.keybinding_list")(function* (
  _input: Record<string, never>,
) {
  yield* requireP3Access("keybinding_list");
  const keybindings = yield* Keybindings.Keybindings;
  const state = yield* keybindings.loadConfigState.pipe(
    Effect.mapError((cause) => toolError("keybinding_list", cause.message)),
  );
  return { keybindings: state.keybindings, issues: state.issues };
});

const keybindingUpsert = Effect.fn("SettingsToolkit.keybinding_upsert")(function* (
  input: ServerUpsertKeybindingInput,
) {
  yield* requireP3Access("keybinding_upsert");
  const keybindings = yield* Keybindings.Keybindings;
  // Same answer as the `server.upsertKeybinding` RPC: the resolved config and its issues.
  return yield* keybindings
    .upsertKeybindingRule(input)
    .pipe(Effect.mapError((cause) => toolError("keybinding_upsert", cause.message)));
});

const keybindingRemove = Effect.fn("SettingsToolkit.keybinding_remove")(function* (
  input: ServerRemoveKeybindingInput,
) {
  yield* requireP3Access("keybinding_remove");
  const keybindings = yield* Keybindings.Keybindings;
  return yield* keybindings
    .removeKeybindingRule(input)
    .pipe(Effect.mapError((cause) => toolError("keybinding_remove", cause.message)));
});

const providerList = Effect.fn("SettingsToolkit.provider_list")(function* (
  _input: Record<string, never>,
) {
  yield* requireP3Access("provider_list");
  const registry = yield* ProviderRegistry.ProviderRegistry;
  return providerListResult(yield* registry.getProviders);
});

const providerRefresh = Effect.fn("SettingsToolkit.provider_refresh")(function* (
  input: McpSettingsProviderRefreshInput,
) {
  yield* requireP3Access("provider_refresh");
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const providers =
    input.instanceId !== undefined
      ? yield* registry.refreshInstance(input.instanceId)
      : yield* registry.refresh();
  return providerListResult(providers);
});

const providerUpdate = Effect.fn("SettingsToolkit.provider_update")(function* (
  input: ServerProviderUpdateInput,
) {
  yield* requireP3Access("provider_update");
  const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const updated = yield* runner
    .updateProvider(input)
    .pipe(Effect.mapError((cause) => toolError("provider_update", cause.message)));
  return providerListResult(updated.providers);
});

/** The theme currently set, with the schema's "unset" empty string as null. */
const currentDefaultTheme = Effect.fn("SettingsToolkit.currentDefaultTheme")(function* (
  tool: McpSettingsToolName,
) {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError((cause) => toolError(tool, cause.message)),
  );
  return settings.defaultTheme.length > 0 ? settings.defaultTheme : null;
});

const themeSet = Effect.fn("SettingsToolkit.theme_set")(function* (
  input: McpSettingsThemeSetInput,
): Effect.fn.Return<McpSettingsThemeSetResult, SettingsToolError, Deps> {
  yield* requireP3Access("theme_set");
  const config = yield* ServerRuntimeConfig.ServerConfig;
  const themeId = input.themeId.trim();
  if (themeId.length > 0) {
    // The same check `t3 theme set` makes: a typo must not be written as a
    // theme no client can resolve.
    const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;
    const known = resolvableThemeIdsFrom(
      (yield* environmentThemes.current).map((theme) => theme.id),
    );
    if (!known.includes(themeId)) {
      return yield* toolError(
        "theme_set",
        `unknown theme "${themeId}". Known ids: ${known.join(", ")}.`,
      );
    }
  }
  yield* writeDefaultTheme({ settingsPath: config.settingsPath, themeId }).pipe(
    Effect.mapError((cause) => toolError("theme_set", cause.message)),
  );
  return {
    defaultTheme: themeId.length > 0 ? themeId : null,
    settingsPath: config.settingsPath,
  };
});

const themeList = Effect.fn("SettingsToolkit.theme_list")(function* (
  _input: Record<string, never>,
): Effect.fn.Return<McpSettingsThemeListResult, SettingsToolError, Deps> {
  yield* requireP3Access("theme_list");
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;
  const published = yield* environmentThemes.current;
  return {
    defaultTheme: yield* currentDefaultTheme("theme_list"),
    builtInThemeIds: [...BUILT_IN_THEME_IDS],
    environmentThemes: published.map((theme) => ({
      id: theme.id,
      name: theme.name,
      appearance: theme.appearance,
    })),
  };
});

export const settingsHandlers = {
  settings_get: settingsGet,
  settings_update: settingsUpdate,
  server_config_get: serverConfigGet,
  keybinding_list: keybindingList,
  keybinding_upsert: keybindingUpsert,
  keybinding_remove: keybindingRemove,
  provider_list: providerList,
  provider_refresh: providerRefresh,
  provider_update: providerUpdate,
  theme_set: themeSet,
  theme_list: themeList,
} satisfies Parameters<typeof SettingsToolkit.toLayer>[0];

// exowatt: declared through McpToolAccess so `/mcp` registers them with an access rule.
const refuse = (tool: McpSettingsToolName) => () =>
  toolError(
    tool,
    `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability; settings tools need it.`,
  );

export const SettingsToolkitHandlersLive = McpToolAccess.toLayer(SettingsToolkit, {
  settings_get: McpToolAccess.usesCommandCenter(refuse("settings_get"), settingsGet),
  settings_update: McpToolAccess.usesCommandCenter(refuse("settings_update"), settingsUpdate),
  server_config_get: McpToolAccess.usesCommandCenter(refuse("server_config_get"), serverConfigGet),
  keybinding_list: McpToolAccess.usesCommandCenter(refuse("keybinding_list"), keybindingList),
  keybinding_upsert: McpToolAccess.usesCommandCenter(refuse("keybinding_upsert"), keybindingUpsert),
  keybinding_remove: McpToolAccess.usesCommandCenter(refuse("keybinding_remove"), keybindingRemove),
  provider_list: McpToolAccess.usesCommandCenter(refuse("provider_list"), providerList),
  provider_refresh: McpToolAccess.usesCommandCenter(refuse("provider_refresh"), providerRefresh),
  provider_update: McpToolAccess.usesCommandCenter(refuse("provider_update"), providerUpdate),
  theme_set: McpToolAccess.usesCommandCenter(refuse("theme_set"), themeSet),
  theme_list: McpToolAccess.usesCommandCenter(refuse("theme_list"), themeList),
} satisfies McpToolAccess.Handlers<typeof SettingsToolkit.tools>);
