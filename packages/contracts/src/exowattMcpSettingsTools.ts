// Exowatt distro: MCP tool contracts (`settings_*`, `keybinding_*`, `provider_*`, `theme_*`) that
// let an outside agent change what the Settings UI changes. They reuse the WebSocket payloads so
// the two transports cannot drift. They need the "command-center" capability, which `t3 agent
// token` sessions hold and in-app provider sessions get while Settings › Sharing & access allows it.
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  EnvironmentThemeId,
  ServerProviderAuth,
  ServerProviderState,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettingsPatch } from "./settings.ts";

export const McpSettingsUpdateInput = Schema.Struct({
  patch: ServerSettingsPatch.annotate({
    description:
      "Sparse patch: only the fields present are written, everything else keeps its value. Same shape the Settings UI sends.",
  }),
});
export type McpSettingsUpdateInput = typeof McpSettingsUpdateInput.Type;

/**
 * The keybinding tools all answer with the resolved config plus the non-fatal
 * issues the config file has, which is exactly what the Settings keybindings
 * page renders.
 */
export const McpSettingsKeybindingsResult = ServerUpsertKeybindingResult;
export type McpSettingsKeybindingsResult = typeof McpSettingsKeybindingsResult.Type;

/** One model an agent may name in a `modelSelection`. */
export const McpSettingsProviderModel = Schema.Struct({
  /** The value that goes in `modelSelection.model`. */
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
});
export type McpSettingsProviderModel = typeof McpSettingsProviderModel.Type;

/**
 * One configured provider instance, trimmed to what an agent needs to pick a
 * model and to see whether the instance can run: the full snapshot also
 * carries slash commands, skills and palette metadata that only the UI reads.
 */
export const McpSettingsProvider = Schema.Struct({
  /** The value that goes in `modelSelection.instanceId`. */
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  /** false when the instance names a driver this build does not have. */
  available: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  /** Why the instance is in `warning`/`error`/`disabled`, when it says. */
  message: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  models: Schema.Array(McpSettingsProviderModel),
});
export type McpSettingsProvider = typeof McpSettingsProvider.Type;

export const McpSettingsProviderListResult = Schema.Struct({
  providers: Schema.Array(McpSettingsProvider),
});
export type McpSettingsProviderListResult = typeof McpSettingsProviderListResult.Type;

export const McpSettingsProviderRefreshInput = Schema.Struct({
  instanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Only re-probe this configured instance. Defaults to every configured instance.",
    }),
  ),
});
export type McpSettingsProviderRefreshInput = typeof McpSettingsProviderRefreshInput.Type;

export const McpSettingsThemeSetInput = Schema.Struct({
  themeId: Schema.String.annotate({
    description:
      "A built-in theme id or one this machine publishes (see theme_list). An empty string clears the environment theme; clients then keep whatever they have.",
  }),
});
export type McpSettingsThemeSetInput = typeof McpSettingsThemeSetInput.Type;

export const McpSettingsThemeSetResult = Schema.Struct({
  /** The id now stored, or null when the theme was cleared. */
  defaultTheme: Schema.NullOr(TrimmedNonEmptyString),
  settingsPath: TrimmedNonEmptyString,
});
export type McpSettingsThemeSetResult = typeof McpSettingsThemeSetResult.Type;

/** One palette this machine publishes, without its colors. */
export const McpSettingsEnvironmentTheme = Schema.Struct({
  id: EnvironmentThemeId,
  name: TrimmedNonEmptyString,
  appearance: Schema.Literals(["light", "dark"]),
});
export type McpSettingsEnvironmentTheme = typeof McpSettingsEnvironmentTheme.Type;

export const McpSettingsThemeListResult = Schema.Struct({
  /** The environment theme in effect, or null when none is set. */
  defaultTheme: Schema.NullOr(TrimmedNonEmptyString),
  /** Ids every web and desktop client of this build can resolve. */
  builtInThemeIds: Schema.Array(TrimmedNonEmptyString),
  /** Palettes this machine publishes from its themes directory. */
  environmentThemes: Schema.Array(McpSettingsEnvironmentTheme),
});
export type McpSettingsThemeListResult = typeof McpSettingsThemeListResult.Type;

export const McpSettingsToolName = Schema.Literals([
  "settings_get",
  "settings_update",
  "server_config_get",
  "keybinding_list",
  "keybinding_upsert",
  "keybinding_remove",
  "provider_list",
  "provider_refresh",
  "provider_update",
  "theme_set",
  "theme_list",
]);
export type McpSettingsToolName = typeof McpSettingsToolName.Type;

export class SettingsToolError extends Schema.TaggedError<SettingsToolError>()(
  "SettingsToolError",
  {
    tool: McpSettingsToolName,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.tool} failed: ${this.detail}`;
  }
}
