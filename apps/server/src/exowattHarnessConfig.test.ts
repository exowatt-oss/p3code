// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise the real filesystem parser boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  applyCodexPluginEnabled,
  applyDisabledNames,
  addMcpServerToContents,
  codexPluginAssets,
  disabledNames,
  parseJsonMcpConfig,
  parseOpenCodeMcpConfig,
  parsePhiMcpStatusOutput,
  parseHarnessMcpEntries,
  parseTomlMcpConfig,
  formatSupportsHttpHeaders,
  upsertMcpServerToContents,
  getHarnessMcpRuntimeStatus,
  listHarnessMcpConfigs,
  resolveHarnessLocations,
  toggleHarnessMcpServer,
  toggleMcpServerInContents,
} from "./exowattHarnessConfig.ts";
import * as HarnessLaunchEnvironment from "./provider/HarnessLaunchEnvironment.ts";

/** `ExowattHarnessConfigError` carries its wording in `reason`, not `message`. */
const addFailureReason = (run: () => string): string => {
  try {
    run();
  } catch (cause) {
    return (cause as { readonly reason?: string }).reason ?? String(cause);
  }
  throw new Error("expected addMcpServerToContents to reject");
};

const fixture = (name: string) =>
  NodeFSP.readFile(
    NodeURL.fileURLToPath(new URL(`./test-fixtures/exowatt-harness/${name}`, import.meta.url)),
    "utf8",
  );

const harnessProcessLayer = Layer.mergeAll(
  NodeServices.layer,
  HarnessLaunchEnvironment.layerTest(undefined),
);

describe("Exowatt harness MCP config", () => {
  it("resolves all provider-registry harness paths", () => {
    const locations = resolveHarnessLocations("/Users/example", {
      CODEX_HOME: "/config/codex",
      CLAUDE_CONFIG_DIR: "/config/claude",
      GROK_HOME: "/config/grok",
      XDG_CONFIG_HOME: "/config",
    });

    expect(Object.keys(locations)).toEqual([
      "phi",
      "codex",
      "claude",
      "cursor",
      "grok",
      "opencode",
    ]);
    expect(locations.phi.configPath).toBe("/Users/example/.pi/agent/mcp.json");
    expect(locations.phi.supportsToggle).toBe(true);
    expect(
      resolveHarnessLocations("/Users/example", {
        PHI_MCP_CONFIG: "/config/phi/custom-mcp.json",
      }).phi.configPath,
    ).toBe("/config/phi/custom-mcp.json");
    expect(locations.codex.configPath).toBe("/config/codex/config.toml");
    expect(locations.claude.configPath).toBe("/config/claude/.claude.json");
    expect(locations.cursor.configPath).toBe("/Users/example/.cursor/mcp.json");
    expect(locations.grok.configPath).toBe("/config/grok/config.toml");
    expect(locations.opencode.configPath).toBe("/config/opencode/opencode.json");
  });

  it.effect("inventories Phi from the captured PHI_MCP_CONFIG path", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p3-phi-custom-config-")),
      );
      const customPath = NodePath.join(directory, "custom-mcp.json");
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.writeFile(
            customPath,
            '{"mcpServers":{"alternate":{"command":"alternate-mcp"}}}\n',
            { mode: 0o600 },
          ),
        ),
        () => Effect.promise(() => NodeFSP.rm(directory, { force: true, recursive: true })),
      );

      const inventory = yield* listHarnessMcpConfigs().pipe(
        Effect.provide(
          HarnessLaunchEnvironment.layerTest({ HOME: directory, PHI_MCP_CONFIG: customPath }),
        ),
      );
      const phi = inventory.harnesses.find((harness) => harness.harness === "phi");
      expect(phi?.sourcePaths).toEqual([customPath]);
      expect(phi?.servers.map((server) => server.name)).toEqual(["alternate"]);
    }).pipe(Effect.scoped),
  );

  it("maps Phi MCP runtime status without conflating it with config status", () => {
    expect(
      parsePhiMcpStatusOutput(
        JSON.stringify({
          schema: 1,
          servers: [
            {
              name: "atlassian",
              transport: "http",
              enabled: true,
              authMode: "oauth",
              credential: "valid",
              expiresAt: "2026-09-05T04:19:24.738Z",
              needsLogin: false,
              loginInProgress: false,
            },
          ],
        }),
      ),
    ).toEqual({
      available: true,
      supportsEnablement: false,
      servers: [
        {
          name: "atlassian",
          transport: "http",
          enabled: true,
          authMode: "oauth",
          credential: "valid",
          expiresAt: "2026-09-05T04:19:24.738Z",
          needsLogin: false,
          loginInProgress: false,
        },
      ],
    });
  });

  it("passes through phi's load-time config error and missing env names", () => {
    const row = {
      name: "slack",
      transport: "http",
      enabled: true,
      authMode: "static",
      credential: "n/a",
      needsLogin: false,
      loginInProgress: false,
      configError:
        "slack.headers.Authorization references $SLACK_USER_TOKEN, which is not set in the environment.",
      missingEnv: ["SLACK_USER_TOKEN"],
    };
    expect(
      parsePhiMcpStatusOutput(
        JSON.stringify({ schema: 1, capabilities: { enablement: true }, servers: [row] }),
      ),
    ).toEqual({
      available: true,
      supportsEnablement: true,
      servers: [row],
    });
  });

  it.each(["not json", '{"error":"Unknown command: mcp"}', '{"schema":2,"servers":[]}'])(
    "degrades unsupported or malformed Phi MCP status output to unavailable: %s",
    (output) => {
      expect(parsePhiMcpStatusOutput(output)).toEqual({
        available: false,
        supportsEnablement: false,
        servers: [],
      });
    },
  );

  it.effect("returns no runtime status for harnesses without a status CLI", () =>
    Effect.gen(function* () {
      expect(yield* getHarnessMcpRuntimeStatus({ harness: "cursor" }, "/does/not/exist")).toEqual({
        available: false,
        supportsEnablement: false,
        servers: [],
      });
    }).pipe(Effect.provide(harnessProcessLayer)),
  );

  it.effect("degrades a missing Codex binary to unavailable", () =>
    Effect.gen(function* () {
      expect(
        yield* getHarnessMcpRuntimeStatus(
          { harness: "codex" },
          undefined,
          {},
          {
            binaryPath: "/does/not/exist/codex",
          },
        ),
      ).toEqual({
        available: false,
        supportsEnablement: false,
        servers: [],
      });
    }).pipe(Effect.provide(harnessProcessLayer)),
  );

  it.effect("degrades a missing Phi binary to unavailable", () =>
    Effect.gen(function* () {
      expect(yield* getHarnessMcpRuntimeStatus({ harness: "phi" }, "/does/not/exist/phi")).toEqual({
        available: false,
        supportsEnablement: false,
        servers: [],
      });
    }).pipe(Effect.provide(harnessProcessLayer)),
  );

  it.effect("launches Phi MCP commands with the captured login environment", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "phi-login-env-")),
      );
      const fakePhi = NodePath.join(directory, "phi");
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.writeFile(
            fakePhi,
            [
              "#!/bin/sh",
              '[ "$P3_TEST_LOGIN_ENV_MARKER" = "from-login" ] || exit 7',
              'printf \'%s\\n\' \'{"schema":1,"capabilities":{"enablement":true},"servers":[]}\'',
              "",
            ].join("\n"),
            { mode: 0o755 },
          ),
        ),
        () => Effect.promise(() => NodeFSP.rm(directory, { force: true, recursive: true })),
      );

      expect(yield* getHarnessMcpRuntimeStatus({ harness: "phi" }, fakePhi)).toEqual({
        available: true,
        supportsEnablement: true,
        servers: [],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          HarnessLaunchEnvironment.layerTest({ P3_TEST_LOGIN_ENV_MARKER: "from-login" }),
        ),
      ),
    ),
  );

  it.effect("delegates Phi enablement to the supported CLI with the login environment", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "phi-toggle-command-")),
      );
      const fakePhi = NodePath.join(directory, "phi");
      const argsPath = NodePath.join(directory, "args.txt");
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.writeFile(
            fakePhi,
            [
              "#!/bin/sh",
              '[ "$P3_TEST_LOGIN_ENV_MARKER" = "from-login" ] || exit 7',
              `printf "%s\\n" "$*" > "${argsPath}"`,
              'printf \'%s\\n\' \'{"schema":1,"server":"demo","enabled":false}\'',
              "",
            ].join("\n"),
            { mode: 0o755 },
          ),
        ),
        () => Effect.promise(() => NodeFSP.rm(directory, { force: true, recursive: true })),
      );

      const result = yield* toggleHarnessMcpServer(
        { harness: "phi", name: "demo", enabled: false },
        fakePhi,
      );
      expect(result).toEqual({
        harness: "phi",
        name: "demo",
        enabled: false,
        inventory: null,
      });
      expect(yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8"))).toBe(
        "mcp disable demo --json\n",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          HarnessLaunchEnvironment.layerTest({ P3_TEST_LOGIN_ENV_MARKER: "from-login" }),
        ),
      ),
    ),
  );

  it.effect("rejects direct toggle RPCs for harnesses without a stable toggle contract", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        toggleHarnessMcpServer({ harness: "claude", name: "demo", enabled: false }),
      );
      expect(failure.reason).toContain("does not expose a stable MCP enable/disable setting");
    }).pipe(Effect.provide(harnessProcessLayer)),
  );

  // Regression: interrupting the scope only sends SIGTERM, so a phi that traps it would keep
  // the RPC pending for the child's whole life and the 10s status timeout would not hold.
  // The fake binary ignores SIGTERM and outlives the project timeout, so this test times out
  // if the force-kill grace is dropped. it.live: the real child needs the real 10s timeout.
  it.live("bounds the status timeout even when Phi ignores SIGTERM", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "phi-stubborn-")),
      );
      const fakePhi = NodePath.join(directory, "phi");
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.writeFile(fakePhi, `#!/bin/sh\ntrap '' TERM\nexec sleep 120\n`, { mode: 0o755 }),
        ),
        () => Effect.promise(() => NodeFSP.rm(directory, { force: true, recursive: true })),
      );

      const result = yield* getHarnessMcpRuntimeStatus({ harness: "phi" }, fakePhi);

      expect(result).toEqual({
        available: false,
        supportsEnablement: false,
        servers: [],
      });
    }).pipe(Effect.scoped, Effect.provide(harnessProcessLayer)),
  );

  it.each([
    ["phi-mcp.json", "Phi", "json"],
    ["claude-mcp.json", "Claude Code", "json"],
    ["cursor-mcp.json", "Cursor Agent", "json"],
  ])("parses the %s fixture for %s", async (fileName, _label, _kind) => {
    const raw = await fixture(fileName);
    const parsed = parseJsonMcpConfig(raw, `/fixtures/${fileName}`);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]?.sourcePath).toBe(`/fixtures/${fileName}`);
  });

  it.each([
    ["codex-config.toml", "Codex", 2],
    ["grok-config.toml", "Grok", 2],
  ])("parses the %s fixture for %s", async (fileName, _label, expectedCount) => {
    const parsed = parseTomlMcpConfig(await fixture(fileName), `/fixtures/${fileName}`);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.servers).toHaveLength(expectedCount);
  });

  it("parses the OpenCode JSONC fixture without exposing environment values", async () => {
    const parsed = parseOpenCodeMcpConfig(
      await fixture("opencode.jsonc"),
      "/fixtures/opencode.jsonc",
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers[0]).toMatchObject({
      name: "docs",
      command: "npx",
      args: ["-y", "@example/docs"],
      envNames: ["DOCS_TOKEN"],
      status: "enabled",
    });
    expect(JSON.stringify(parsed)).not.toContain("${DOCS_TOKEN}");
    expect(parsed.servers[1]).toMatchObject({ name: "linear", status: "disabled" });
  });

  it("writes a valid JSON MCP server while preserving neighboring keys", async () => {
    const raw = await fixture("phi-mcp.json");
    const next = addMcpServerToContents("json-mcpServers", raw, {
      harness: "phi",
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.example",
      args: [],
      env: [],
    });
    const parsed = parseJsonMcpConfig(next, "/tmp/mcp.json");

    expect(parsed.servers.map((server) => server.name)).toEqual(["docs", "linear"]);
    expect(JSON.parse(next).imports).toEqual(["cursor"]);
  });

  it("writes and toggles a valid TOML MCP server without replacing existing settings", async () => {
    const raw = await fixture("codex-config.toml");
    const added = addMcpServerToContents("toml-mcp-servers", raw, {
      harness: "codex",
      name: "search",
      transport: "stdio",
      command: "uvx",
      args: ["example-server"],
      env: [{ name: "API_KEY", value: "${API_KEY}" }],
    });
    const toggled = toggleMcpServerInContents("toml-mcp-servers", added, "search", false);
    const parsed = parseTomlMcpConfig(toggled, "/tmp/config.toml");

    expect(toggled).toContain('model = "gpt-5"');
    expect(parsed.servers.find((server) => server.name === "search")).toMatchObject({
      status: "disabled",
      command: "uvx",
      envNames: ["API_KEY"],
    });
  });

  it("writes and toggles an OpenCode MCP server in JSONC", async () => {
    const raw = await fixture("opencode.jsonc");
    const added = addMcpServerToContents("opencode-json", raw, {
      harness: "opencode",
      name: "search",
      transport: "stdio",
      command: "uvx",
      args: ["example-server"],
      env: [],
    });
    const toggled = toggleMcpServerInContents("opencode-json", added, "search", false);
    const parsed = parseOpenCodeMcpConfig(toggled, "/tmp/opencode.jsonc");

    expect(parsed.servers.find((server) => server.name === "search")).toMatchObject({
      status: "disabled",
      command: "uvx",
      args: ["example-server"],
    });
  });

  it("parses and toggles Codex plugin tables", async () => {
    const raw = await fixture("codex-config.toml");
    expect(codexPluginAssets(raw, "/tmp/config.toml")).toEqual([
      expect.objectContaining({ name: "documents@example", status: "enabled" }),
      expect.objectContaining({ name: "legacy@example", status: "disabled" }),
    ]);

    const toggled = applyCodexPluginEnabled(raw, "documents@example", false);
    expect(codexPluginAssets(toggled, "/tmp/config.toml")[0]).toMatchObject({
      name: "documents@example",
      status: "disabled",
    });
  });

  it("writes an HTTP MCP server with its bearer header and an explicit transport", async () => {
    const raw = await fixture("phi-mcp.json");
    const next = addMcpServerToContents("json-mcpServers", raw, {
      harness: "phi",
      name: "board",
      transport: "http",
      url: "https://board.example.com/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer tok_example" }],
    });

    expect(JSON.parse(next).mcpServers.board).toEqual({
      type: "http",
      url: "https://board.example.com/mcp",
      headers: { Authorization: "Bearer tok_example" },
    });
    expect(JSON.parse(next).imports).toEqual(["cursor"]);
  });

  it("writes an OpenCode remote MCP server with its headers", async () => {
    const next = addMcpServerToContents("opencode-json", "{}\n", {
      harness: "opencode",
      name: "board",
      transport: "http",
      url: "https://board.example.com/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer tok_example" }],
    });

    expect(JSON.parse(next).mcp.board).toEqual({
      type: "remote",
      url: "https://board.example.com/mcp",
      enabled: true,
      headers: { Authorization: "Bearer tok_example" },
    });
  });

  it("writes Codex's http_headers and Grok's headers for a token-bearing HTTP server", async () => {
    const codex = addMcpServerToContents("toml-mcp-servers", await fixture("codex-config.toml"), {
      harness: "codex",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:3773/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer eyJ.codex" }],
    });
    const grok = addMcpServerToContents("toml-mcp-servers", await fixture("grok-config.toml"), {
      harness: "grok",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:3773/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer eyJ.grok" }],
    });

    expect(codex).toContain('http_headers = { "Authorization" = "Bearer eyJ.codex" }');
    expect(grok).toContain('headers = { "Authorization" = "Bearer eyJ.grok" }');
    // The header must not disturb the rest of the harness's config, and the
    // inventory parser has to keep reading the server it belongs to.
    expect(codex).toContain('model = "gpt-5"');
    expect(grok).toContain('disabled = ["legacy-skill"]');
    expect(
      parseTomlMcpConfig(codex, "/tmp/config.toml").servers.find((server) => server.name === "p3"),
    ).toMatchObject({ transport: "http", url: "http://127.0.0.1:3773/mcp", status: "enabled" });
    expect(parseTomlMcpConfig(grok, "/tmp/config.toml").warnings).toEqual([]);
    expect(formatSupportsHttpHeaders("toml-mcp-servers")).toBe(true);
    expect(formatSupportsHttpHeaders("json-mcpServers")).toBe(true);
    expect(formatSupportsHttpHeaders("opencode-json")).toBe(true);
  });

  it("reads either TOML header spelling back, and JSON headers too", async () => {
    const both = [
      "[mcp_servers.codexish]",
      'url = "http://127.0.0.1:3773/mcp"',
      'http_headers = { "Authorization" = "Bearer from-http-headers" }',
      "",
      "[mcp_servers.grokish]",
      'url = "http://127.0.0.1:3773/mcp"',
      'headers = { "Authorization" = "Bearer from-headers" }',
      "",
      "[mcp_servers.local]",
      'command = "uvx"',
      "",
    ].join("\n");

    expect(parseHarnessMcpEntries("toml-mcp-servers", both)).toEqual([
      {
        name: "codexish",
        url: "http://127.0.0.1:3773/mcp",
        headers: { Authorization: "Bearer from-http-headers" },
      },
      {
        name: "grokish",
        url: "http://127.0.0.1:3773/mcp",
        headers: { Authorization: "Bearer from-headers" },
      },
      { name: "local", url: null, headers: {} },
    ]);
    expect(parseHarnessMcpEntries("toml-mcp-servers", "not = toml = at = all")).toEqual([]);

    const json = addMcpServerToContents("json-mcpServers", await fixture("phi-mcp.json"), {
      harness: "phi",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:3773/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer eyJ.phi" }],
    });
    expect(parseHarnessMcpEntries("json-mcpServers", json)).toContainEqual({
      name: "p3",
      url: "http://127.0.0.1:3773/mcp",
      headers: { Authorization: "Bearer eyJ.phi" },
    });
    expect(
      parseHarnessMcpEntries("opencode-json", await fixture("opencode.jsonc")).map(
        (entry) => entry.name,
      ),
    ).toEqual(["docs", "linear"]);
  });

  it("upserts a JSON MCP server over an existing entry of the same name", async () => {
    const raw = await fixture("phi-mcp.json");
    const first = upsertMcpServerToContents("json-mcpServers", raw, {
      harness: "phi",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:3773/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer first" }],
    });
    const second = upsertMcpServerToContents("json-mcpServers", first, {
      harness: "phi",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:4000/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer second" }],
    });
    const parsed = JSON.parse(second);

    expect(parsed.mcpServers.p3).toEqual({
      type: "http",
      url: "http://127.0.0.1:4000/mcp",
      headers: { Authorization: "Bearer second" },
    });
    expect(Object.keys(parsed.mcpServers)).toEqual(["docs", "p3"]);
    expect(parsed.imports).toEqual(["cursor"]);
  });

  it("upserts an OpenCode MCP server while keeping the JSONC comments", async () => {
    const raw = `// P3 wrote this file\n${await fixture("opencode.jsonc")}`;
    const next = upsertMcpServerToContents("opencode-json", raw, {
      harness: "opencode",
      name: "linear",
      transport: "http",
      url: "https://mcp.example.com/v2",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer rotated" }],
    });
    const parsed = parseOpenCodeMcpConfig(next, "/tmp/opencode.jsonc");

    expect(next).toContain("// P3 wrote this file");
    expect(parsed.servers.map((server) => server.name)).toEqual(["docs", "linear"]);
    expect(parseHarnessMcpEntries("opencode-json", next)).toContainEqual({
      name: "linear",
      url: "https://mcp.example.com/v2",
      headers: { Authorization: "Bearer rotated" },
    });
  });

  it("upserts a TOML MCP server by replacing its block, not appending a second one", async () => {
    const raw = await fixture("codex-config.toml");
    const first = upsertMcpServerToContents("toml-mcp-servers", raw, {
      harness: "codex",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:3773/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer first" }],
    });
    const second = upsertMcpServerToContents("toml-mcp-servers", first, {
      harness: "codex",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:4000/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer second" }],
    });

    expect(second.match(/\[mcp_servers\.p3\]/g)).toHaveLength(1);
    expect(second).not.toContain("Bearer first");
    expect(parseHarnessMcpEntries("toml-mcp-servers", second)).toContainEqual({
      name: "p3",
      url: "http://127.0.0.1:4000/mcp",
      headers: { Authorization: "Bearer second" },
    });
    // Neighbouring servers and plain settings survive the replacement.
    expect(second).toContain('model = "gpt-5"');
    expect(second).toContain("[mcp_servers.docs]");
    expect(second).toContain('[plugins."documents@example"]');
    expect(
      parseTomlMcpConfig(second, "/tmp/config.toml").servers.map((server) => server.name),
    ).toEqual(["docs", "linear", "p3"]);
  });

  it("upserts into an empty config the same way it adds", () => {
    const input = {
      harness: "phi",
      name: "p3",
      transport: "http",
      url: "http://127.0.0.1:3773/mcp",
      args: [],
      env: [],
      headers: [{ name: "Authorization", value: "Bearer fresh" }],
    } as const;

    expect(
      JSON.parse(upsertMcpServerToContents("json-mcpServers", "", input)).mcpServers.p3,
    ).toEqual({
      type: "http",
      url: "http://127.0.0.1:3773/mcp",
      headers: { Authorization: "Bearer fresh" },
    });
    expect(upsertMcpServerToContents("toml-mcp-servers", "", { ...input, harness: "grok" })).toBe(
      [
        "[mcp_servers.p3]",
        "enabled = true",
        'url = "http://127.0.0.1:3773/mcp"',
        'headers = { "Authorization" = "Bearer fresh" }',
        "",
      ].join("\n"),
    );
  });

  it("rejects an invalid HTTP header name", async () => {
    const raw = await fixture("phi-mcp.json");

    expect(
      addFailureReason(() =>
        addMcpServerToContents("json-mcpServers", raw, {
          harness: "phi",
          name: "board",
          transport: "http",
          url: "https://board.example.com/mcp",
          args: [],
          env: [],
          headers: [{ name: "Bad Header", value: "x" }],
        }),
      ),
    ).toMatch(/Invalid HTTP header name/);
  });

  it("updates Grok disabled lists without disturbing neighboring config", async () => {
    const raw = await fixture("grok-config.toml");
    expect([...disabledNames(raw, "skills")]).toEqual(["legacy-skill"]);

    const next = applyDisabledNames(raw, "skills", new Set(["review", "deploy"]));
    expect([...disabledNames(next, "skills")].sort()).toEqual(["deploy", "review"]);
    expect(next).toContain("[mcp_servers.search]");
    expect(next).toContain('disabled = ["legacy-plugin"]');
  });
});
