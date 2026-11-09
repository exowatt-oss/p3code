// Exowatt distro: the Settings MCP toolkit, every server-authoritative action on the
// Settings pages as a tool. Descriptions are written for a caller who cannot see the UI.
// Tool names are a wire contract; keep them stable. Every handler requires the
// "command-center" capability (see `requireP3Access` in handlers.ts).
import {
  McpSettingsKeybindingsResult,
  McpSettingsProviderListResult,
  McpSettingsProviderRefreshInput,
  McpSettingsThemeListResult,
  McpSettingsThemeSetInput,
  McpSettingsThemeSetResult,
  McpSettingsUpdateInput,
  ServerConfig,
  ServerProviderUpdateInput,
  ServerRemoveKeybindingInput,
  ServerSettings,
  ServerUpsertKeybindingInput,
  SettingsToolError,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
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
import * as ServerSettingsService from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettingsService.ServerSettingsService,
  Keybindings.Keybindings,
  ProviderRegistry.ProviderRegistry,
  ProviderMaintenanceRunner.ProviderMaintenanceRunner,
  EnvironmentTheme.EnvironmentThemeService,
  ServerRuntimeConfig.ServerConfig,
  ServerEnvironment.ServerEnvironment,
  EnvironmentAuth.EnvironmentAuth,
  ExternalLauncher.ExternalLauncher,
  RemoteOpenTargets.RemoteOpenTargets,
  DirectEndpoints.DirectEndpoints,
  ManagedProjectFolders.ManagedProjectFolders,
  // `theme_set` writes the environment's settings.json atomically.
  FileSystem.FileSystem,
  Path.Path,
];

export const SettingsGetTool = Tool.make("settings_get", {
  description:
    "Read this environment's server settings, exactly as the Settings pages show them: provider settings, background activity, auto-settle, agent browser access, the text-generation and source-control writer models, observability, and the configured provider instances. Sensitive provider environment variables come back empty with `valueRedacted: true`. Read-only.",
  parameters: Tool.EmptyParams,
  success: ServerSettings,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get server settings")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SettingsUpdateTool = Tool.make("settings_update", {
  description:
    "Change server settings with a sparse patch: only the fields you send are written, and the full (redacted) settings come back. Takes effect immediately for every connected client. `providerInstances` is whole-map replacement: send the complete map from settings_get with your edit applied, or you will drop the instances you left out.",
  parameters: McpSettingsUpdateInput,
  success: ServerSettings,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update server settings")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ServerConfigGetTool = Tool.make("server_config_get", {
  description:
    "Read the whole config a client bootstraps from: the execution environment and auth descriptors, the state directory paths, resolved keybindings and their config issues, provider snapshots, available editors and remote-open targets, observability endpoints, and the redacted settings. Use it once to see the shape of the environment, then the narrower tools to change things. Read-only.",
  parameters: Tool.EmptyParams,
  success: ServerConfig,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get server config")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const KeybindingListTool = Tool.make("keybinding_list", {
  description:
    "List the resolved keybindings this environment serves to its clients, with the non-fatal issues its keybindings file has. Read-only.",
  parameters: Tool.EmptyParams,
  success: McpSettingsKeybindingsResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List keybindings")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const KeybindingUpsertTool = Tool.make("keybinding_upsert", {
  description:
    'Bind a key to a command, e.g. { key: "mod+k", command: "palette.open" }. Pass `when` for a context-scoped binding, and `replace` with the exact key/command/when of an existing rule to rebind it instead of adding one. Returns the resolved keybindings after the write.',
  parameters: ServerUpsertKeybindingInput,
  success: McpSettingsKeybindingsResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Upsert keybinding")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const KeybindingRemoveTool = Tool.make("keybinding_remove", {
  description:
    "Remove one persisted keybinding rule by exact key/command/when match, as keybinding_list reports it. Returns the resolved keybindings after the write; a command with no rule left falls back to its default binding.",
  parameters: ServerRemoveKeybindingInput,
  success: McpSettingsKeybindingsResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Remove keybinding")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ProviderListTool = Tool.make("provider_list", {
  description:
    "List the configured provider instances with whether each is enabled, installed and authenticated, its CLI version, and the models it offers. `instanceId` and a model `slug` are the two halves of a `modelSelection`, so this is how you find a valid one. Read-only.",
  parameters: Tool.EmptyParams,
  success: McpSettingsProviderListResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List providers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ProviderRefreshTool = Tool.make("provider_refresh", {
  description:
    "Re-probe provider instances (installed version, auth status, model list) and return the refreshed snapshots. Pass `instanceId` for one instance, omit it for all of them. Installs nothing.",
  parameters: McpSettingsProviderRefreshInput,
  success: McpSettingsProviderListResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Refresh providers")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ProviderUpdateTool = Tool.make("provider_update", {
  description:
    "Install or update a provider's CLI on this machine (the Settings page's Update button) and return the refreshed provider snapshots. This runs a package manager, changes what is installed outside P3, and can take minutes; the new version applies to sessions started after it finishes. Only run it when the user asked for it. Not idempotent: a second call can install a newer release.",
  parameters: ServerProviderUpdateInput,
  success: McpSettingsProviderListResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update a provider CLI")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ThemeSetTool = Tool.make("theme_set", {
  description:
    "Set this environment's theme, the way `t3 theme set <id>` does: connected web and desktop clients switch to it. The id must be a built-in or one this machine publishes (see theme_list); an empty string clears the theme and leaves clients with what they have. Mobile keeps its own appearance settings. This is a separate tool because `defaultTheme` is deliberately not part of settings_update.",
  parameters: McpSettingsThemeSetInput,
  success: McpSettingsThemeSetResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set the environment theme")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThemeListTool = Tool.make("theme_list", {
  description:
    "List the theme ids theme_set accepts (this build's built-ins plus the palettes this machine publishes), along with the environment theme currently set. Read-only.",
  parameters: Tool.EmptyParams,
  success: McpSettingsThemeListResult,
  failure: SettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "List themes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SettingsToolkit = Toolkit.make(
  SettingsGetTool,
  SettingsUpdateTool,
  ServerConfigGetTool,
  KeybindingListTool,
  KeybindingUpsertTool,
  KeybindingRemoveTool,
  ProviderListTool,
  ProviderRefreshTool,
  ProviderUpdateTool,
  ThemeSetTool,
  ThemeListTool,
);
