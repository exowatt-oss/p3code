import { AuthSessionId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../../../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { makeEnvironmentSessionScope } from "../../McpToolVisibility.ts";
import { clientSettingsHandlers } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-client-settings-test");

const environmentSession: McpInvocationScope = {
  ...makeEnvironmentSessionScope({
    environmentId: environmentId,
    sessionId: AuthSessionId.make("session-1"),
    subject: "claude-code",
    issuedAt: 1,
  }),
  capabilities: new Set(["command-center"]),
};

const providerSession: McpInvocationScope = {
  environmentId,
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-relay"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("phi"),
  },
  client: undefined,
  capabilities: new Set(["command-center"]),
  issuedAt: 1,
};

const layerFor = (invocation: McpInvocationScope) =>
  Layer.mergeAll(Layer.succeed(McpInvocationContext, invocation), ServerSettings.layerTest());

describe("client settings push toolkit", () => {
  it.effect("records the patch with a fresh generation and reads it back", () =>
    Effect.gen(function* () {
      const applied = yield* clientSettingsHandlers.client_settings_apply({
        patch: { glassOpacity: 90, "exowatt.accent": "ocean" },
      });
      assert.deepStrictEqual([...applied.keys].toSorted(), ["exowatt.accent", "glassOpacity"]);
      assert.ok(applied.setAt.length > 0);

      const stored = yield* clientSettingsHandlers.client_settings_push_get({});
      assert.deepStrictEqual(stored, {
        patch: { glassOpacity: 90, "exowatt.accent": "ocean" },
        setAt: applied.setAt,
      });
    }).pipe(Effect.provide(layerFor(environmentSession))),
  );

  it.effect("a later push replaces the earlier one whole", () =>
    Effect.gen(function* () {
      yield* clientSettingsHandlers.client_settings_apply({
        patch: { glassOpacity: 60, fontSizeInterface: 18 },
      });
      const second = yield* clientSettingsHandlers.client_settings_apply({
        patch: { glassOpacity: 90 },
      });
      const stored = yield* clientSettingsHandlers.client_settings_push_get({});
      assert.deepStrictEqual(stored, { patch: { glassOpacity: 90 }, setAt: second.setAt });
    }).pipe(Effect.provide(layerFor(environmentSession))),
  );

  it.effect("refuses an empty patch", () =>
    Effect.gen(function* () {
      const error = yield* clientSettingsHandlers
        .client_settings_apply({ patch: {} })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ClientSettingsToolError");
      assert.strictEqual(error.tool, "client_settings_apply");
    }).pipe(Effect.provide(layerFor(environmentSession))),
  );

  it.effect("lets an in-app provider session with the capability push settings", () =>
    Effect.gen(function* () {
      const applied = yield* clientSettingsHandlers.client_settings_apply({
        patch: { glassOpacity: 90 },
      });
      assert.deepStrictEqual([...applied.keys], ["glassOpacity"]);
    }).pipe(Effect.provide(layerFor(providerSession))),
  );

  it.effect("refuses a credential without the command-center capability", () =>
    Effect.gen(function* () {
      const error = yield* clientSettingsHandlers
        .client_settings_apply({ patch: { glassOpacity: 90 } })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ClientSettingsToolError");
      assert.match(error.detail, /command-center/);
    }).pipe(Effect.provide(layerFor({ ...providerSession, capabilities: new Set(["preview"]) }))),
  );
});
