import {
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type KeybindingRule,
  ProviderDriverKind,
  ProviderInstanceId,
  type ResolvedKeybindingRule,
  type ServerAuthDescriptor,
  type ServerProvider,
  type ServerSettings as ServerSettingsPayload,
  type ServerSettingsPatch,
  type SettingsToolError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

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
import * as ServerSettings from "../../../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { makeEnvironmentSessionScope } from "../../McpToolVisibility.ts";
import { settingsHandlers } from "./handlers.ts";
import { SettingsToolkit } from "./tools.ts";

/** The settings file as written: read back as-is so the test sees the keys. */
const decodeSettingsFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const NOW = "2026-09-09T12:00:00.000Z";
const PHI = ProviderInstanceId.make("phi");

const ENVIRONMENT_DESCRIPTOR: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "workstation",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.37",
  capabilities: { repositoryIdentity: true },
};

const AUTH_DESCRIPTOR: ServerAuthDescriptor = {
  policy: "loopback-browser",
  bootstrapMethods: [],
  sessionMethods: [],
  sessionCookieName: "t3_session",
};

/** A settings object with one sensitive provider environment variable in it. */
const SETTINGS_WITH_SECRET: ServerSettingsPayload = {
  ...DEFAULT_SERVER_SETTINGS,
  enableAgentBrowserAccess: false,
  providerInstances: {
    [PHI]: {
      driver: ProviderDriverKind.make("phi"),
      environment: [
        { name: "PHI_TOKEN", value: "super-secret", sensitive: true },
        { name: "PHI_REGION", value: "us-east-1", sensitive: false },
      ],
    },
  },
};

const SHORTCUT = {
  key: "k",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
} as const;

const RESOLVED_RULE: ResolvedKeybindingRule = {
  command: "sidebar.toggle",
  shortcut: SHORTCUT,
};

const PROVIDER: ServerProvider = {
  instanceId: PHI,
  driver: ProviderDriverKind.make("phi"),
  displayName: "Phi",
  enabled: true,
  installed: true,
  version: "1.2.3",
  status: "ready",
  auth: { status: "authenticated", email: "person@example.com" },
  checkedAt: NOW,
  models: [
    { slug: "opus", name: "Opus 5", isCustom: false, isDefault: true, capabilities: null },
    { slug: "luna", name: "Luna", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

/** An outside coding agent holding a `t3 agent token` bearer session. */
function environmentSessionScope(): McpInvocationScope {
  return {
    ...makeEnvironmentSessionScope({
      environmentId: ENVIRONMENT_DESCRIPTOR.environmentId,
      sessionId: AuthSessionId.make("session-agent"),
      subject: "claude-code",
      issuedAt: 0,
    }),
    capabilities: new Set(["command-center"]),
  };
}

/** A linked environment's session, minted by another P3 desktop. */
function peerSessionScope(): McpInvocationScope {
  return {
    ...makeEnvironmentSessionScope({
      environmentId: ENVIRONMENT_DESCRIPTOR.environmentId,
      sessionId: AuthSessionId.make("session-peer"),
      subject: "p3-peer",
      issuedAt: 0,
      peer: true,
    }),
    capabilities: new Set(["command-center"]),
  };
}

/** An agent P3 started itself, running inside a thread. */
function providerSessionScope(): McpInvocationScope {
  return {
    environmentId: ENVIRONMENT_DESCRIPTOR.environmentId,
    requestNamespace: "session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: PHI,
    },
    client: undefined,
    capabilities: new Set(["command-center"]),
    issuedAt: 0,
  };
}

interface PublishedTheme {
  readonly id: string;
  readonly name: string;
  readonly appearance: "light" | "dark";
}

interface HarnessOptions {
  readonly invocation?: McpInvocationScope;
  readonly settings?: ServerSettingsPayload;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly publishedThemes?: ReadonlyArray<PublishedTheme>;
}

const makeHarness = Effect.fn("makeSettingsHarness")(function* (options: HarnessOptions = {}) {
  const patches = yield* Ref.make<ReadonlyArray<ServerSettingsPatch>>([]);
  const upserts = yield* Ref.make<ReadonlyArray<KeybindingRule>>([]);
  const removals = yield* Ref.make<ReadonlyArray<KeybindingRule>>([]);
  const refreshes = yield* Ref.make<ReadonlyArray<ProviderInstanceId | "all">>([]);
  const updates = yield* Ref.make<
    ReadonlyArray<{ readonly provider: string; readonly instanceId: string | null }>
  >([]);
  const settings = options.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = options.providers ?? [PROVIDER];

  const layer = Layer.mergeAll(
    Layer.mock(ServerSettings.ServerSettingsService)({
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed(settings),
      updateSettings: (patch) =>
        Ref.update(patches, (recorded) => [...recorded, patch]).pipe(Effect.as(settings)),
      streamChanges: Stream.empty,
    }),
    Layer.mock(Keybindings.Keybindings)({
      loadConfigState: Effect.succeed({ keybindings: [RESOLVED_RULE], issues: [] }),
      upsertKeybindingRule: (input) =>
        Ref.update(upserts, (recorded) => [
          ...recorded,
          { key: input.key, command: input.command },
        ]).pipe(Effect.as({ keybindings: [RESOLVED_RULE], issues: [] })),
      removeKeybindingRule: (input) =>
        Ref.update(removals, (recorded) => [
          ...recorded,
          { key: input.key, command: input.command },
        ]).pipe(Effect.as({ keybindings: [], issues: [] })),
      streamChanges: Stream.empty,
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refresh: () =>
        Ref.update(refreshes, (recorded) => [...recorded, "all" as const]).pipe(
          Effect.as(providers),
        ),
      refreshInstance: (instanceId) =>
        Ref.update(refreshes, (recorded) => [...recorded, instanceId]).pipe(Effect.as(providers)),
      streamChanges: Stream.empty,
    }),
    Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({
      updateProvider: (target) =>
        Ref.update(updates, (recorded) => [
          ...recorded,
          typeof target === "string"
            ? { provider: target, instanceId: null }
            : { provider: target.provider, instanceId: target.instanceId ?? null },
        ]).pipe(Effect.as({ providers })),
    }),
    Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
      current: Effect.succeed(
        (options.publishedThemes ?? []).map((theme) => ({
          id: theme.id,
          name: theme.name,
          appearance: theme.appearance,
        })),
      ),
      streamChanges: Stream.empty,
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed(ENVIRONMENT_DESCRIPTOR),
    }),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      getDescriptor: () => Effect.succeed(AUTH_DESCRIPTOR),
    }),
    Layer.mock(ExternalLauncher.ExternalLauncher)({
      resolveAvailableEditors: () => Effect.succeed([]),
      resolveFileManagerRevealKind: () => Effect.undefined,
    }),
    Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
      resolveTargets: () => Effect.succeed([]),
    }),
    Layer.mock(DirectEndpoints.DirectEndpoints)({
      resolve: () => Effect.succeed([]),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      scratchRoot: Effect.succeedNone,
      namedProjectsRoot: "/tmp/t3-projects",
    }),
    Layer.succeed(McpInvocationContext, options.invocation ?? environmentSessionScope()),
    // A real settings.json in a temp state directory: `theme_set` writes the
    // file the running server watches, so the write is the behavior to test.
    ServerRuntimeConfig.layerTest(process.cwd(), { prefix: "t3code-mcp-settings-" }).pipe(
      Layer.provide(NodeServices.layer),
      // A temp directory this test cannot create is a broken machine, not a
      // case the handlers should have to type.
      Layer.orDie,
    ),
    NodeServices.layer,
  );

  return { layer, patches, upserts, removals, refreshes, updates };
});

describe("SettingsToolkit tools", () => {
  // The MCP transport advertises each tool's parameters as JSON Schema, and
  // these reuse the WebSocket payloads wholesale (`ServerSettingsPatch` most
  // of all). A schema that cannot be represented would only surface as a
  // broken `tools/list` for every client.
  it("describe their parameters as JSON Schema", () => {
    for (const tool of Object.values(SettingsToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool) as { readonly type?: string };
      assert.strictEqual(schema.type, "object", tool.name);
    }
  });
});

/** Every tool must refuse the same way; the error is the whole assertion. */
const expectRefusal = <A>(attempt: Effect.Effect<A, SettingsToolError>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(attempt);
    assert.strictEqual(error._tag, "SettingsToolError");
    assert.include(error.detail, "command-center");
  });

/** A credential P3 minted with browser access only: no P3 tools. */
function previewOnlyScope(): McpInvocationScope {
  return { ...providerSessionScope(), capabilities: new Set(["preview"]) };
}

describe("settingsHandlers authorization", () => {
  it.effect("refuses every tool for a credential without the command-center capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ invocation: previewOnlyScope() });
      const layer = harness.layer;
      yield* expectRefusal(settingsHandlers.settings_get({}).pipe(Effect.provide(layer)));
      yield* expectRefusal(
        settingsHandlers
          .settings_update({ patch: { enableAgentBrowserAccess: true } })
          .pipe(Effect.provide(layer)),
      );
      yield* expectRefusal(settingsHandlers.server_config_get({}).pipe(Effect.provide(layer)));
      yield* expectRefusal(settingsHandlers.keybinding_list({}).pipe(Effect.provide(layer)));
      yield* expectRefusal(
        settingsHandlers
          .keybinding_upsert({ key: "mod+k", command: "sidebar.toggle" })
          .pipe(Effect.provide(layer)),
      );
      yield* expectRefusal(
        settingsHandlers
          .keybinding_remove({ key: "mod+k", command: "sidebar.toggle" })
          .pipe(Effect.provide(layer)),
      );
      yield* expectRefusal(settingsHandlers.provider_list({}).pipe(Effect.provide(layer)));
      yield* expectRefusal(settingsHandlers.provider_refresh({}).pipe(Effect.provide(layer)));
      yield* expectRefusal(
        settingsHandlers
          .provider_update({ provider: ProviderDriverKind.make("phi") })
          .pipe(Effect.provide(layer)),
      );
      yield* expectRefusal(
        settingsHandlers.theme_set({ themeId: "ocean" }).pipe(Effect.provide(layer)),
      );
      yield* expectRefusal(settingsHandlers.theme_list({}).pipe(Effect.provide(layer)));
      // Nothing was written on the way to the refusal.
      assert.deepStrictEqual(yield* Ref.get(harness.patches), []);
      assert.deepStrictEqual(yield* Ref.get(harness.upserts), []);
      assert.deepStrictEqual(yield* Ref.get(harness.removals), []);
      assert.deepStrictEqual(yield* Ref.get(harness.updates), []);
      assert.deepStrictEqual(yield* Ref.get(harness.refreshes), []);
    }),
  );

  // Exowatt: an agent running inside P3 may reconfigure the environment it runs on.
  it.effect("lets an in-app provider session with the capability read and change settings", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ invocation: providerSessionScope() });
      yield* settingsHandlers
        .settings_update({ patch: { enableAgentBrowserAccess: false } })
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(yield* Ref.get(harness.patches), [
        { enableAgentBrowserAccess: false },
      ]);
    }),
  );

  it.effect("lets only a human-minted agent token change cross-environment reach", () =>
    Effect.gen(function* () {
      for (const patch of [
        { exowattCrossEnvironmentAgentTools: true },
        { exowattPeerInbound: "full-access" as const },
      ]) {
        for (const invocation of [providerSessionScope(), peerSessionScope()]) {
          const harness = yield* makeHarness({ invocation });
          const error = yield* settingsHandlers
            .settings_update({ patch })
            .pipe(Effect.provide(harness.layer), Effect.flip);
          assert.include(error.detail, "Settings › Sharing & access");
          assert.include(error.detail, Object.keys(patch)[0]!);
          assert.deepStrictEqual(yield* Ref.get(harness.patches), []);
        }
        const harness = yield* makeHarness({ invocation: environmentSessionScope() });
        yield* settingsHandlers.settings_update({ patch }).pipe(Effect.provide(harness.layer));
        assert.deepStrictEqual(yield* Ref.get(harness.patches), [patch]);
      }
    }),
  );
});

describe("settingsHandlers settings", () => {
  it.effect("settings_get redacts sensitive provider environment values", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ settings: SETTINGS_WITH_SECRET });
      const settings = yield* settingsHandlers.settings_get({}).pipe(Effect.provide(harness.layer));
      const environment = settings.providerInstances[PHI]?.environment ?? [];
      assert.deepStrictEqual(environment[0], {
        name: "PHI_TOKEN",
        value: "",
        sensitive: true,
        valueRedacted: true,
      });
      assert.deepStrictEqual(environment[1], {
        name: "PHI_REGION",
        value: "us-east-1",
        sensitive: false,
      });
    }),
  );

  it.effect("settings_update passes the patch through and answers redacted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ settings: SETTINGS_WITH_SECRET });
      const patch: ServerSettingsPatch = {
        enableAgentBrowserAccess: true,
        enableAgentP3Tools: true,
      };
      const settings = yield* settingsHandlers
        .settings_update({ patch })
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(yield* Ref.get(harness.patches), [patch]);
      assert.strictEqual(settings.providerInstances[PHI]?.environment?.[0]?.value, "");
    }),
  );

  it.effect("server_config_get returns what a client bootstraps from", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ settings: SETTINGS_WITH_SECRET });
      const config = yield* settingsHandlers
        .server_config_get({})
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(config.environment, ENVIRONMENT_DESCRIPTOR);
      assert.deepStrictEqual(config.auth, AUTH_DESCRIPTOR);
      assert.deepStrictEqual(config.keybindings, [RESOLVED_RULE]);
      assert.deepStrictEqual(config.providers, [PROVIDER]);
      assert.isTrue(config.keybindingsConfigPath.endsWith("keybindings.json"));
      assert.strictEqual(config.settings.providerInstances[PHI]?.environment?.[0]?.value, "");
      assert.deepStrictEqual(config.availableEditors, []);
    }),
  );
});

describe("settingsHandlers keybindings", () => {
  it.effect("keybinding_list reports the resolved config", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* settingsHandlers
        .keybinding_list({})
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(result, { keybindings: [RESOLVED_RULE], issues: [] });
    }),
  );

  it.effect("keybinding_upsert and keybinding_remove write through the service", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const upserted = yield* settingsHandlers
        .keybinding_upsert({ key: "mod+k", command: "sidebar.toggle" })
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(upserted.keybindings, [RESOLVED_RULE]);
      const removed = yield* settingsHandlers
        .keybinding_remove({ key: "mod+k", command: "sidebar.toggle" })
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(removed.keybindings, []);
      assert.deepStrictEqual(yield* Ref.get(harness.upserts), [
        { key: "mod+k", command: "sidebar.toggle" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(harness.removals), [
        { key: "mod+k", command: "sidebar.toggle" },
      ]);
    }),
  );
});

describe("settingsHandlers providers", () => {
  it.effect("provider_list gives an agent the halves of a modelSelection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* settingsHandlers.provider_list({}).pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(result.providers, [
        {
          instanceId: PHI,
          driver: ProviderDriverKind.make("phi"),
          displayName: "Phi",
          enabled: true,
          installed: true,
          available: true,
          version: "1.2.3",
          status: "ready",
          auth: { status: "authenticated", email: "person@example.com" },
          message: null,
          checkedAt: NOW,
          models: [
            { slug: "opus", name: "Opus 5", isDefault: true },
            { slug: "luna", name: "Luna", isDefault: false },
          ],
        },
      ]);
    }),
  );

  it.effect("provider_refresh targets one instance or every instance", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* settingsHandlers.provider_refresh({}).pipe(Effect.provide(harness.layer));
      yield* settingsHandlers
        .provider_refresh({ instanceId: PHI })
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(yield* Ref.get(harness.refreshes), ["all", PHI]);
    }),
  );

  it.effect("provider_update runs the installer for the requested driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* settingsHandlers
        .provider_update({ provider: ProviderDriverKind.make("phi"), instanceId: PHI })
        .pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(yield* Ref.get(harness.updates), [
        { provider: ProviderDriverKind.make("phi"), instanceId: PHI },
      ]);
      assert.strictEqual(result.providers[0]?.instanceId, PHI);
    }),
  );
});

describe("settingsHandlers themes", () => {
  it.effect("theme_list names the ids theme_set accepts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: { ...DEFAULT_SERVER_SETTINGS, defaultTheme: "nightfall" },
        publishedThemes: [{ id: "nightfall", name: "Nightfall", appearance: "dark" }],
      });
      const result = yield* settingsHandlers.theme_list({}).pipe(Effect.provide(harness.layer));
      assert.strictEqual(result.defaultTheme, "nightfall");
      assert.include(result.builtInThemeIds, "ocean");
      assert.deepStrictEqual(result.environmentThemes, [
        { id: "nightfall", name: "Nightfall", appearance: "dark" },
      ]);
    }),
  );

  it.effect("theme_list reports no theme when none is set", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* settingsHandlers.theme_list({}).pipe(Effect.provide(harness.layer));
      assert.strictEqual(result.defaultTheme, null);
      assert.deepStrictEqual(result.environmentThemes, []);
    }),
  );

  it.effect("theme_set writes a built-in id into the environment's settings file", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const written = yield* Effect.gen(function* () {
        const result = yield* settingsHandlers.theme_set({ themeId: "ocean" });
        const fs = yield* FileSystem.FileSystem;
        const raw = yield* fs.readFileString(result.settingsPath);
        return { result, settings: yield* decodeSettingsFile(raw) };
      }).pipe(Effect.orDie, Effect.provide(harness.layer));
      assert.strictEqual(written.result.defaultTheme, "ocean");
      assert.strictEqual(written.settings.defaultTheme, "ocean");
      // The set-generation stamp is what lets a client re-apply a repeat set.
      assert.isString(written.settings.defaultThemeSetAt);
    }),
  );

  it.effect("theme_set accepts a theme this machine publishes and clears on empty", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        publishedThemes: [{ id: "nightfall", name: "Nightfall", appearance: "dark" }],
      });
      const cleared = yield* Effect.gen(function* () {
        yield* settingsHandlers.theme_set({ themeId: "nightfall" });
        const result = yield* settingsHandlers.theme_set({ themeId: "" });
        const fs = yield* FileSystem.FileSystem;
        const raw = yield* fs.readFileString(result.settingsPath);
        return { result, settings: yield* decodeSettingsFile(raw) };
      }).pipe(Effect.orDie, Effect.provide(harness.layer));
      assert.strictEqual(cleared.result.defaultTheme, null);
      assert.notProperty(cleared.settings, "defaultTheme");
      assert.notProperty(cleared.settings, "defaultThemeSetAt");
    }),
  );

  it.effect("theme_set refuses an id no client could resolve", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* settingsHandlers
        .theme_set({ themeId: "nightfall" })
        .pipe(Effect.flip, Effect.provide(harness.layer));
      assert.strictEqual(error.tool, "theme_set");
      assert.include(error.detail, 'unknown theme "nightfall"');
      assert.include(error.detail, "ocean");
    }),
  );
});
