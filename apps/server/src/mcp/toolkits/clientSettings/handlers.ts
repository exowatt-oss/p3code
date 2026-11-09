// Exowatt distro: handlers for the client-settings push toolkit. The push is one server
// setting (`exowattClientSettingsPush`) written through the ordinary settings patch, so it
// persists, streams to every connected client, and is redacted like everything else.
// `setAt` is the generation clients key their once-only apply on.
import {
  type ClientSettingsApplyInput,
  type ClientSettingsApplyResult,
  type ClientSettingsPushGetResult,
  ClientSettingsToolError,
  type ClientSettingsToolName,
  EXOWATT_THREADS_MCP_CAPABILITY,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ClientSettingsToolkit } from "./tools.ts";

type Deps = McpInvocationContext.McpInvocationContext | ServerSettings.ServerSettingsService;

const toolError = (tool: ClientSettingsToolName, detail: string) =>
  new ClientSettingsToolError({ tool, detail });

/** Any P3-issued credential carrying the command-center capability may push preferences. */
const requireP3Access = Effect.fn("ClientSettingsToolkit.requireP3Access")(function* (
  tool: ClientSettingsToolName,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
    return yield* toolError(
      tool,
      `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`,
    );
  }
  return invocation;
});

const clientSettingsApply = Effect.fn("ClientSettingsToolkit.client_settings_apply")(function* (
  input: ClientSettingsApplyInput,
): Effect.fn.Return<ClientSettingsApplyResult, ClientSettingsToolError, Deps> {
  yield* requireP3Access("client_settings_apply");
  const keys = Object.keys(input.patch);
  if (keys.length === 0) {
    return yield* toolError("client_settings_apply", "patch must name at least one setting");
  }
  const settings = yield* ServerSettings.ServerSettingsService;
  const setAt = DateTime.formatIso(yield* DateTime.now);
  yield* settings
    .updateSettings({ exowattClientSettingsPush: { patch: input.patch, setAt } })
    .pipe(Effect.mapError((cause) => toolError("client_settings_apply", cause.message)));
  return { setAt, keys };
});

const clientSettingsPushGet = Effect.fn("ClientSettingsToolkit.client_settings_push_get")(
  function* (
    _input: Record<string, never>,
  ): Effect.fn.Return<ClientSettingsPushGetResult, ClientSettingsToolError, Deps> {
    yield* requireP3Access("client_settings_push_get");
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => toolError("client_settings_push_get", cause.message)),
    );
    return current.exowattClientSettingsPush;
  },
);

export const clientSettingsHandlers = {
  client_settings_apply: clientSettingsApply,
  client_settings_push_get: clientSettingsPushGet,
} satisfies Parameters<typeof ClientSettingsToolkit.toLayer>[0];

// exowatt: declared through McpToolAccess so `/mcp` registers them with an access rule.
const refuse = (tool: ClientSettingsToolName) => () =>
  toolError(tool, `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability`);

export const ClientSettingsToolkitHandlersLive = McpToolAccess.toLayer(ClientSettingsToolkit, {
  client_settings_apply: McpToolAccess.usesCommandCenter(
    refuse("client_settings_apply"),
    clientSettingsApply,
  ),
  client_settings_push_get: McpToolAccess.usesCommandCenter(
    refuse("client_settings_push_get"),
    clientSettingsPushGet,
  ),
} satisfies McpToolAccess.Handlers<typeof ClientSettingsToolkit.tools>);
