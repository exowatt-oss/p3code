import { describe, expect, it } from "@effect/vitest";

import { parseCodexMcpListOutput } from "./exowattCodexMcp.ts";

const LIST_OUTPUT = JSON.stringify([
  {
    name: "RepoPrompt",
    enabled: false,
    disabled_reason: null,
    transport: { type: "stdio", command: "/Users/me/RepoPrompt/repoprompt_cli", args: [] },
    auth_status: "unsupported",
  },
  {
    name: "p3",
    enabled: true,
    transport: { type: "streamable_http", url: "http://127.0.0.1:3773/mcp" },
    auth_status: "bearer_token",
  },
  {
    name: "linear",
    enabled: true,
    transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp" },
    auth_status: "not_logged_in",
  },
  {
    name: "monday",
    enabled: true,
    transport: { type: "streamable_http", url: "https://mcp.monday.com/mcp" },
    auth_status: "oauth",
  },
  {
    name: "old-build",
    enabled: true,
    transport: { type: "stdio", command: "npx", args: ["-y", "@example/server"] },
  },
  { enabled: true, transport: { type: "stdio", command: "nameless" } },
]);

describe("Exowatt Codex MCP status", () => {
  it("parses every row of `codex mcp list --json` with its auth state", () => {
    const status = parseCodexMcpListOutput(`${LIST_OUTPUT}\n`);
    expect(status?.available).toBe(true);
    expect(status?.supportsEnablement).toBe(false);
    expect(status?.servers.map((server) => server.name)).toEqual([
      "RepoPrompt",
      "p3",
      "linear",
      "monday",
      "old-build",
    ]);
    expect(
      status?.servers.map((server) => [
        server.transport,
        server.enabled,
        server.authMode,
        server.credential,
        server.needsLogin,
      ]),
    ).toEqual([
      ["stdio", false, "none", "n/a", false],
      ["http", true, "static", "n/a", false],
      ["http", true, "oauth", "absent", true],
      ["http", true, "oauth", "valid", false],
      ["stdio", true, "none", "n/a", false],
    ]);
    expect(status?.servers.map((server) => server.target)).toEqual([
      "/Users/me/RepoPrompt/repoprompt_cli",
      "http://127.0.0.1:3773/mcp",
      "https://mcp.linear.app/mcp",
      "https://mcp.monday.com/mcp",
      "npx -y @example/server",
    ]);
  });

  it("tolerates a warning line before the JSON", () => {
    const status = parseCodexMcpListOutput(`warning: something\n${LIST_OUTPUT}`);
    expect(status?.servers).toHaveLength(5);
  });

  it("reads a table or an empty answer as no answer, not as an empty inventory", () => {
    expect(parseCodexMcpListOutput("Name  Status\nlinear  ok\n")).toBeNull();
    expect(parseCodexMcpListOutput("")).toBeNull();
    expect(parseCodexMcpListOutput("[not json")).toBeNull();
    expect(parseCodexMcpListOutput("[]")).toEqual({
      available: true,
      supportsEnablement: false,
      servers: [],
    });
  });
});
