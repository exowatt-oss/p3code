// @effect-diagnostics nodeBuiltinImport:off - these tests write real harness config files.
// @effect-diagnostics globalJsonInEffect:off - the fixtures are the harness
// configs and token payloads P3 has to cope with, byte for byte.
//
// Every test runs against a temporary HOME. Nothing here may touch the
// developer's own `~/.pi`, `~/.claude.json`, `~/.cursor`, `~/.codex`, `~/.grok`
// or `~/.config/opencode`.
import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthClientSession,
  type ExowattConnectorAutoConnectReport,
  type ExowattHarnessId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import {
  bearerTokenFromHeaders,
  devServerSkipReason,
  ExowattConnectorAutoConnect,
  layer as autoConnectLayer,
  sessionIdFromToken,
} from "./exowattConnectorAutoConnect.ts";
import { parseHarnessMcpEntries } from "./exowattHarnessConfig.ts";
import * as HarnessLaunchEnvironment from "./provider/HarnessLaunchEnvironment.ts";
import * as ServerSettings from "./serverSettings.ts";

const ORIGIN = "http://127.0.0.1:3773";
const P3_URL = `${ORIGIN}/mcp`;

/** A P3 bearer token: base64url claims, a dot, and a signature we never check. */
const tokenFor = (sessionId: string) =>
  `${Buffer.from(JSON.stringify({ v: 1, kind: "session", sid: sessionId }), "utf8").toString(
    "base64url",
  )}.signature`;

const session = (input: {
  readonly sessionId: string;
  readonly expiresAt: DateTime.Utc;
  readonly label: string;
}): AuthClientSession => ({
  sessionId: AuthSessionId.make(input.sessionId),
  subject: input.label,
  scopes: AuthStandardClientScopes,
  method: "bearer-access-token",
  client: { label: input.label, deviceType: "unknown" },
  issuedAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
  expiresAt: input.expiresAt,
  lastConnectedAt: null,
  connected: false,
  current: false,
});

/** A temporary HOME with only the harnesses a test says are installed. */
const temporaryHome = Effect.fn("temporaryHome")(function* (
  installed: ReadonlyArray<ExowattHarnessId> = [],
) {
  const home = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p3-auto-connect-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { force: true, recursive: true })),
  );
  const roots: Readonly<Record<ExowattHarnessId, string>> = {
    phi: NodePath.join(home, ".pi", "agent"),
    codex: NodePath.join(home, ".codex"),
    claude: NodePath.join(home, ".claude"),
    cursor: NodePath.join(home, ".cursor"),
    grok: NodePath.join(home, ".grok"),
    opencode: NodePath.join(home, ".config", "opencode"),
  };
  yield* Effect.promise(() =>
    Promise.all(
      installed.map((harness) => NodeFSP.mkdir(roots[harness], { recursive: true })),
    ).then(() => undefined),
  );
  return { home, roots };
});

const writeRuntimeState = (
  path: string,
  state: { readonly origin?: string; readonly devUrl?: string } = {},
) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        pid: 1234,
        port: 3773,
        origin: state.origin ?? ORIGIN,
        ...(state.devUrl ? { devUrl: state.devUrl } : {}),
        startedAt: "2026-09-09T12:00:00.000Z",
      })}\n`,
      "utf8",
    );
  });

const readConfig = (path: string) =>
  Effect.promise(() => NodeFSP.readFile(path, "utf8").catch(() => ""));

const configExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );

interface HarnessOptions {
  readonly home: string;
  readonly serverRuntimeStatePath: string;
  readonly enabled?: boolean;
  /** Sessions `listSessions` reports before the run mints anything. */
  readonly sessions?: ReadonlyArray<AuthClientSession>;
  readonly listSessionsFails?: boolean;
}

const makeHarness = Effect.fn("makeAutoConnectHarness")(function* (options: HarnessOptions) {
  const now = yield* DateTime.now;
  const sessionsRef = yield* Ref.make<ReadonlyArray<AuthClientSession>>(options.sessions ?? []);
  const issued = yield* Ref.make<ReadonlyArray<{ label: string; sessionId: string }>>([]);
  const revoked = yield* Ref.make<ReadonlyArray<string>>([]);

  const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    issueSession: (input) =>
      Effect.gen(function* () {
        const label = input?.label ?? "(none)";
        const count = (yield* Ref.get(issued)).length + 1;
        const sessionId = `session-minted-${count}`;
        const expiresAt = DateTime.addDuration(now, Duration.days(30));
        yield* Ref.update(issued, (labels) => [...labels, { label, sessionId }]);
        yield* Ref.update(sessionsRef, (list) => [
          ...list,
          session({ sessionId, expiresAt, label }),
        ]);
        return {
          sessionId: AuthSessionId.make(sessionId),
          token: tokenFor(sessionId),
          method: "bearer-access-token" as const,
          scopes: AuthStandardClientScopes,
          subject: input?.subject ?? label,
          client: { deviceType: "unknown" as const },
          expiresAt,
        };
      }),
    listSessions: () =>
      options.listSessionsFails === true
        ? Effect.die("listSessions is unavailable in this test")
        : Ref.get(sessionsRef),
    revokeSession: (sessionId) =>
      Ref.update(revoked, (ids) => [...ids, sessionId]).pipe(
        Effect.andThen(
          Ref.update(sessionsRef, (list) =>
            list.filter((candidate) => candidate.sessionId !== sessionId),
          ),
        ),
        Effect.as(true),
      ),
  });

  const layer = autoConnectLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        authLayer,
        HarnessLaunchEnvironment.layerTest({ HOME: options.home }),
        Layer.succeed(ServerConfig.ServerConfig, {
          serverRuntimeStatePath: options.serverRuntimeStatePath,
        } as never),
        ServerSettings.layerTest({ exowattAutoConnectHarnesses: options.enabled ?? true }),
        NodeServices.layer,
      ),
    ),
  );

  const reconcile = Effect.flatMap(
    ExowattConnectorAutoConnect,
    (service) => service.reconcileNow,
  ).pipe(Effect.provide(layer));

  return { issued, revoked, reconcile, now };
});

const actionFor = (report: ExowattConnectorAutoConnectReport, harness: ExowattHarnessId) =>
  report.harnesses.find((row) => row.harness === harness)?.action;

describe("Exowatt connector auto-connect", () => {
  it("reads the session id out of a token, and refuses what it cannot read", () => {
    assert.strictEqual(sessionIdFromToken(tokenFor("session-7")), "session-7");
    assert.strictEqual(sessionIdFromToken("not-a-token"), null);
    assert.strictEqual(sessionIdFromToken(""), null);
    // Right shape, wrong claims.
    assert.strictEqual(
      sessionIdFromToken(`${Buffer.from('{"nope":1}', "utf8").toString("base64url")}.sig`),
      null,
    );
  });

  it("finds the bearer token whatever case the header was written in", () => {
    assert.strictEqual(bearerTokenFromHeaders({ authorization: "Bearer abc" }), "abc");
    assert.strictEqual(bearerTokenFromHeaders({ Authorization: "bearer abc" }), "abc");
    assert.strictEqual(bearerTokenFromHeaders({ Authorization: "Basic abc" }), null);
    assert.strictEqual(bearerTokenFromHeaders({}), null);
  });

  it("refuses to write the machine's configs from a dev build", () => {
    assert.strictEqual(
      devServerSkipReason({ version: "0.0.0-dev.abc1234", devUrl: undefined }),
      "This is a dev server build.",
    );
    assert.strictEqual(
      devServerSkipReason({ version: "0.0.37", devUrl: "http://localhost:5173" }),
      "This server is fronting a dev web server.",
    );
    assert.strictEqual(devServerSkipReason({ version: "0.0.37", devUrl: undefined }), null);
  });

  it.effect("connects the installed harnesses and leaves the rest alone", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor", "codex"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      const harness = yield* makeHarness({ home, serverRuntimeStatePath: statePath });

      const report = yield* harness.reconcile;

      assert.strictEqual(report.origin, ORIGIN);
      assert.strictEqual(actionFor(report, "cursor"), "added");
      assert.strictEqual(actionFor(report, "codex"), "added");
      for (const harnessId of ["phi", "claude", "grok", "opencode"] as const) {
        assert.strictEqual(actionFor(report, harnessId), "skipped");
      }
      // One session per connected harness, in inventory order, labelled for
      // Authorized Clients.
      assert.deepStrictEqual(
        (yield* Ref.get(harness.issued)).map(({ label }) => label),
        ["p3-auto:codex", "p3-auto:cursor"],
      );

      // Codex is TOML, and gets the token under `http_headers`.
      const codex = yield* readConfig(NodePath.join(roots.codex, "config.toml"));
      assert.include(codex, 'http_headers = { "Authorization"');
      assert.deepStrictEqual(parseHarnessMcpEntries("toml-mcp-servers", codex), [
        {
          name: "p3",
          url: P3_URL,
          headers: { Authorization: `Bearer ${tokenFor("session-minted-1")}` },
        },
      ]);
      const cursor = yield* readConfig(NodePath.join(roots.cursor, "mcp.json"));
      assert.deepStrictEqual(parseHarnessMcpEntries("json-mcpServers", cursor), [
        {
          name: "p3",
          url: P3_URL,
          headers: { Authorization: `Bearer ${tokenFor("session-minted-2")}` },
        },
      ]);
      // A harness the person does not have gets no config directory conjured.
      assert.strictEqual(yield* configExists(NodePath.join(home, ".grok", "config.toml")), false);
      assert.strictEqual(yield* configExists(NodePath.join(home, ".claude.json")), false);
    }).pipe(Effect.scoped),
  );

  it.effect("writes nothing on a second run", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      const harness = yield* makeHarness({ home, serverRuntimeStatePath: statePath });
      const configPath = NodePath.join(roots.cursor, "mcp.json");

      yield* harness.reconcile;
      const afterFirst = yield* readConfig(configPath);
      const second = yield* harness.reconcile;

      assert.strictEqual(actionFor(second, "cursor"), "unchanged");
      assert.strictEqual(yield* readConfig(configPath), afterFirst);
      assert.strictEqual((yield* Ref.get(harness.issued)).length, 1);
      assert.deepStrictEqual(yield* Ref.get(harness.revoked), []);
    }).pipe(Effect.scoped),
  );

  it.effect("moves the entry when the server changed origin, and drops the old session", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      const now = yield* DateTime.now;
      const configPath = NodePath.join(roots.cursor, "mcp.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          configPath,
          `${JSON.stringify({
            mcpServers: {
              p3: {
                type: "http",
                url: "http://127.0.0.1:9999/mcp",
                headers: { Authorization: `Bearer ${tokenFor("session-old")}` },
              },
              docs: { command: "npx", args: ["-y", "@example/docs"] },
            },
          })}\n`,
          "utf8",
        ),
      );
      const harness = yield* makeHarness({
        home,
        serverRuntimeStatePath: statePath,
        sessions: [
          session({
            sessionId: "session-old",
            expiresAt: DateTime.addDuration(now, Duration.days(29)),
            label: "p3-auto:cursor",
          }),
        ],
      });

      const report = yield* harness.reconcile;

      assert.strictEqual(actionFor(report, "cursor"), "moved");
      assert.deepStrictEqual(yield* Ref.get(harness.revoked), ["session-old"]);
      const entries = parseHarnessMcpEntries("json-mcpServers", yield* readConfig(configPath));
      assert.deepStrictEqual(
        entries.map((entry) => entry.name),
        ["p3", "docs"],
      );
      assert.deepStrictEqual(entries[0], {
        name: "p3",
        url: P3_URL,
        headers: { Authorization: `Bearer ${tokenFor("session-minted-1")}` },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("rotates a token that is about to expire", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["opencode"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      const now = yield* DateTime.now;
      const configPath = NodePath.join(roots.opencode, "opencode.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          configPath,
          `${JSON.stringify({
            mcp: {
              p3: {
                type: "remote",
                url: P3_URL,
                enabled: true,
                headers: { Authorization: `Bearer ${tokenFor("session-stale")}` },
              },
            },
          })}\n`,
          "utf8",
        ),
      );
      const harness = yield* makeHarness({
        home,
        serverRuntimeStatePath: statePath,
        sessions: [
          session({
            sessionId: "session-stale",
            expiresAt: DateTime.addDuration(now, Duration.days(3)),
            label: "p3-auto:opencode",
          }),
        ],
      });

      const report = yield* harness.reconcile;

      assert.strictEqual(actionFor(report, "opencode"), "rotated");
      assert.deepStrictEqual(yield* Ref.get(harness.revoked), ["session-stale"]);
      assert.deepStrictEqual(
        parseHarnessMcpEntries("opencode-json", yield* readConfig(configPath)),
        [
          {
            name: "p3",
            url: P3_URL,
            headers: { Authorization: `Bearer ${tokenFor("session-minted-1")}` },
          },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rotates a token whose session is gone, and one it cannot read", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor", "grok"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(roots.cursor, "mcp.json"),
          `${JSON.stringify({
            mcpServers: {
              p3: {
                type: "http",
                url: P3_URL,
                headers: { Authorization: `Bearer ${tokenFor("session-revoked")}` },
              },
            },
          })}\n`,
          "utf8",
        ),
      );
      // Grok's entry points here but carries nothing P3 can identify.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(roots.grok, "config.toml"),
          ["[mcp_servers.p3]", "enabled = true", `url = "${P3_URL}"`, ""].join("\n"),
          "utf8",
        ),
      );
      // `listSessions` knows about neither.
      const harness = yield* makeHarness({ home, serverRuntimeStatePath: statePath });

      const report = yield* harness.reconcile;

      assert.strictEqual(actionFor(report, "cursor"), "rotated");
      assert.strictEqual(actionFor(report, "grok"), "rotated");
      // Nothing to revoke: one session was already gone, the other unreadable.
      assert.deepStrictEqual(yield* Ref.get(harness.revoked), []);
      const grok = yield* readConfig(NodePath.join(roots.grok, "config.toml"));
      assert.include(grok, 'headers = { "Authorization"');
      assert.strictEqual(grok.match(/\[mcp_servers\.p3\]/g)?.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a healthy entry alone when it cannot check the session list", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      const configPath = NodePath.join(roots.cursor, "mcp.json");
      const contents = `${JSON.stringify({
        mcpServers: {
          p3: {
            type: "http",
            url: P3_URL,
            headers: { Authorization: `Bearer ${tokenFor("session-unknown")}` },
          },
        },
      })}\n`;
      yield* Effect.promise(() => NodeFSP.writeFile(configPath, contents, "utf8"));
      const harness = yield* makeHarness({
        home,
        serverRuntimeStatePath: statePath,
        listSessionsFails: true,
      });

      const report = yield* harness.reconcile;

      assert.strictEqual(actionFor(report, "cursor"), "unchanged");
      assert.strictEqual(yield* readConfig(configPath), contents);
      assert.deepStrictEqual(yield* Ref.get(harness.issued), []);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing when the setting is off", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      const harness = yield* makeHarness({
        home,
        serverRuntimeStatePath: statePath,
        enabled: false,
      });

      const report = yield* harness.reconcile;

      assert.strictEqual(report.enabled, false);
      assert.deepStrictEqual(
        report.harnesses.map((row) => row.action),
        ["skipped", "skipped", "skipped", "skipped", "skipped", "skipped"],
      );
      assert.include(report.harnesses[0]?.detail ?? "", "switched off");
      assert.strictEqual(yield* configExists(NodePath.join(roots.cursor, "mcp.json")), false);
      assert.deepStrictEqual(yield* Ref.get(harness.issued), []);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing on a dev server, or before an origin is recorded", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      const harness = yield* makeHarness({ home, serverRuntimeStatePath: statePath });

      const withoutState = yield* harness.reconcile;
      assert.include(withoutState.harnesses[0]?.detail ?? "", "recorded its origin");
      assert.strictEqual(withoutState.origin, null);

      yield* writeRuntimeState(statePath, { devUrl: "http://localhost:5173" });
      const asDevServer = yield* harness.reconcile;
      assert.include(asDevServer.harnesses[0]?.detail ?? "", "dev web server");
      assert.deepStrictEqual(
        asDevServer.harnesses.map((row) => row.action),
        ["skipped", "skipped", "skipped", "skipped", "skipped", "skipped"],
      );
      assert.strictEqual(yield* configExists(NodePath.join(roots.cursor, "mcp.json")), false);
      assert.deepStrictEqual(yield* Ref.get(harness.issued), []);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a harness whose config it cannot parse as failed", () =>
    Effect.gen(function* () {
      const { home, roots } = yield* temporaryHome(["cursor"]);
      const statePath = NodePath.join(home, "server-runtime.json");
      yield* writeRuntimeState(statePath);
      const broken = "{ this is not json";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(roots.cursor, "mcp.json"), broken, "utf8"),
      );
      const harness = yield* makeHarness({ home, serverRuntimeStatePath: statePath });

      const report = yield* harness.reconcile;

      assert.strictEqual(actionFor(report, "cursor"), "failed");
      // The file it could not understand is left exactly as it was, and the
      // session minted on the way there is revoked rather than orphaned.
      assert.strictEqual(yield* readConfig(NodePath.join(roots.cursor, "mcp.json")), broken);
      assert.deepStrictEqual(yield* Ref.get(harness.revoked), ["session-minted-1"]);
    }).pipe(Effect.scoped),
  );
});
