// Exowatt distro: the client-settings push toolkit. Tool names are a wire
// contract; keep them stable.
import {
  ClientSettingsApplyInput,
  ClientSettingsApplyResult,
  ClientSettingsPushGetResult,
  ClientSettingsToolError,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettings.ServerSettingsService,
];

export const ClientSettingsApplyTool = Tool.make("client_settings_apply", {
  description:
    "Set client-local P3 settings (appearance, fonts, sidebar layout, confirmations, browser defaults) on every client of this environment. These live in each client's own storage, so this records a push that connected clients apply immediately and later clients apply on connect; a preference the user changes afterwards sticks until the next push. Use settings_update for server settings instead.",
  parameters: ClientSettingsApplyInput,
  success: ClientSettingsApplyResult,
  failure: ClientSettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Push client settings")
  .annotate(Tool.Destructive, false);

export const ClientSettingsPushGetTool = Tool.make("client_settings_push_get", {
  description:
    "The last client-settings push recorded on this environment (patch and when it was set). Client settings themselves cannot be read from the server; this is what every client was last asked to apply. Read-only.",
  parameters: Tool.EmptyParams,
  success: ClientSettingsPushGetResult,
  failure: ClientSettingsToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get last client settings push")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ClientSettingsToolkit = Toolkit.make(
  ClientSettingsApplyTool,
  ClientSettingsPushGetTool,
);
