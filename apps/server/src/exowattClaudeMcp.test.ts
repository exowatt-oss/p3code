import { describe, expect, it } from "@effect/vitest";

import {
  CLAUDE_AI_CONNECTOR_PREFIX,
  parseClaudeMcpListOutput,
  parseClaudeMcpLoginOutput,
} from "./exowattClaudeMcp.ts";

const LIST_OUTPUT = [
  "Checking MCP server health…",
  "",
  "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected",
  "claude.ai Otter.ai: https://mcp.otter.ai/mcp - ! Needs authentication",
  'claude.ai Home Lab: https://home-lab.example.ts.net:8443/mcp - ✘ Failed to connect — HTTP 502: Error POSTing to endpoint: {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/","title":"Error 502: Bad gateway","status":502}',
  "claude.ai Flow: https://backend.flow.example.com/mcp/team - ! Needs authentication",
  "monday: https://mcp.monday.com/mcp (HTTP) - ! Needs authentication",
  "p3: http://127.0.0.1:3773/mcp (HTTP) - ✔ Connected",
  "local-tool: npx -y @example/server --flag - ⏸ Pending approval",
  "",
].join("\n");

describe("Exowatt Claude Code MCP status", () => {
  it("parses every row of `claude mcp list` with its transport and target", () => {
    const rows = parseClaudeMcpListOutput(LIST_OUTPUT);
    expect(rows.map((row) => row.name)).toEqual([
      "claude.ai Gmail",
      "claude.ai Otter.ai",
      "claude.ai Home Lab",
      "claude.ai Flow",
      "monday",
      "p3",
      "local-tool",
    ]);
    expect(rows.map((row) => row.target)).toEqual([
      "https://gmailmcp.googleapis.com/mcp/v1",
      "https://mcp.otter.ai/mcp",
      "https://home-lab.example.ts.net:8443/mcp",
      "https://backend.flow.example.com/mcp/team",
      "https://mcp.monday.com/mcp",
      "http://127.0.0.1:3773/mcp",
      "npx -y @example/server --flag",
    ]);
    expect(rows.map((row) => row.transport)).toEqual([
      "http",
      "http",
      "http",
      "http",
      "http",
      "http",
      "stdio",
    ]);
  });

  it("marks claude.ai connectors as managed by claude.ai and the rest as unmanaged", () => {
    const rows = parseClaudeMcpListOutput(LIST_OUTPUT);
    const managed = rows.filter((row) => row.managedBy === "claude.ai").map((row) => row.name);
    expect(managed).toEqual([
      "claude.ai Gmail",
      "claude.ai Otter.ai",
      "claude.ai Home Lab",
      "claude.ai Flow",
    ]);
    expect(managed.every((name) => name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX))).toBe(true);
    expect(rows.find((row) => row.name === "monday")?.managedBy).toBeUndefined();
  });

  it("maps connected, needs-authentication, failed and pending rows to credential state", () => {
    const byName = new Map(parseClaudeMcpListOutput(LIST_OUTPUT).map((row) => [row.name, row]));
    expect(byName.get("claude.ai Gmail")).toMatchObject({
      enabled: true,
      credential: "valid",
      needsLogin: false,
      connectionError: null,
    });
    expect(byName.get("monday")).toMatchObject({
      enabled: true,
      credential: "absent",
      needsLogin: true,
      connectionError: null,
    });
    expect(byName.get("claude.ai Home Lab")).toMatchObject({
      enabled: true,
      credential: "n/a",
      needsLogin: false,
    });
    expect(byName.get("claude.ai Home Lab")?.connectionError).toMatch(/^HTTP 502: Error POSTing/u);
    expect(byName.get("claude.ai Home Lab")?.connectionError?.length).toBeLessThanOrEqual(200);
    expect(byName.get("local-tool")).toMatchObject({ enabled: false, needsLogin: false });
  });

  it("skips headers, blanks and lines that are not server rows", () => {
    expect(
      parseClaudeMcpListOutput("Checking MCP server health…\n\nNo MCP servers configured.\n"),
    ).toEqual([]);
    expect(parseClaudeMcpListOutput("")).toEqual([]);
  });

  it("reads the authorization page and the follow-up sentence out of `claude mcp login`", () => {
    expect(
      parseClaudeMcpLoginOutput(
        [
          "Visit this URL to authorize:",
          "  https://claude.ai/api/organizations/abc/mcp/start-auth/mcpsrv_1?redirect_url=x",
          "",
          "Once authorized on claude.ai, the connector will be available the next time you start Claude Code.",
        ].join("\n"),
      ),
    ).toEqual({
      authorizationUrl:
        "https://claude.ai/api/organizations/abc/mcp/start-auth/mcpsrv_1?redirect_url=x",
      detail:
        "Once authorized on claude.ai, the connector will be available the next time you start Claude Code.",
    });
    expect(parseClaudeMcpLoginOutput("")).toEqual({ authorizationUrl: null, detail: null });
  });
});
