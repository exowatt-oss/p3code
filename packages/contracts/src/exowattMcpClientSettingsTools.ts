// Exowatt distro: MCP tool contracts for pushing client-local settings. Those live in each client's
// own storage, so `client_settings_apply` records a patch on the environment
// (ServerSettings.exowattClientSettingsPush) that every client applies once, on connect if later.
// See `useClientSettingsPushAdoption` in apps/web.
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ClientSettingsPatch } from "./settings.ts";

export const ClientSettingsApplyInput = Schema.Struct({
  patch: ClientSettingsPatch.annotate({
    description:
      "Client-local settings to set on every P3 client: appearance (glassOpacity, appearanceContrast, exowatt.accent, fontSize*, fontFamily*, fontSmoothing), sidebar (exowatt.sidebarDensity, exowatt.sidebarSort, exowatt.sidebarSortReversed, exowatt.sidebarGroupByProject, exowatt.sidebarNestDispatched), Phi display (exowatt.workspaceStateCallouts session-state callouts, exowatt.phiMcpNotices MCP connection notices), sidebar filters (exowatt.sidebarFilterWindow: all|24h|48h|7d, exowatt.sidebarFilterThisDevice, exowatt.sidebarFilterNeedsMe, exowatt.sidebarFilterHideSettled), confirmations (confirmQuit, confirmThreadArchive, confirmThreadDelete), browser defaults, timestampFormat, wordWrap, favorites, providerModelPreferences. Pass only the keys to change; at least one is required.",
  }),
});
export type ClientSettingsApplyInput = typeof ClientSettingsApplyInput.Type;

export const ClientSettingsApplyResult = Schema.Struct({
  /** The push generation; clients apply each generation exactly once. */
  setAt: IsoDateTime,
  /** The keys the push carries. */
  keys: Schema.Array(TrimmedNonEmptyString),
});
export type ClientSettingsApplyResult = typeof ClientSettingsApplyResult.Type;

export const ClientSettingsPushGetResult = Schema.Struct({
  /** The last push recorded on this environment, or an empty patch with setAt "" when none. */
  patch: ClientSettingsPatch,
  setAt: Schema.String,
});
export type ClientSettingsPushGetResult = typeof ClientSettingsPushGetResult.Type;

export const ClientSettingsToolName = Schema.Literals([
  "client_settings_apply",
  "client_settings_push_get",
]);
export type ClientSettingsToolName = typeof ClientSettingsToolName.Type;

export class ClientSettingsToolError extends Schema.TaggedError<ClientSettingsToolError>()(
  "ClientSettingsToolError",
  {
    tool: ClientSettingsToolName,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.tool} failed: ${this.detail}`;
  }
}
