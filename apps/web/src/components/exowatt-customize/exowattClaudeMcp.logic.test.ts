import type { ExowattMcpRuntimeStatus, ExowattMcpServer } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  claudeRuntimeStatusLine,
  claudeServersOutsideInventory,
  describeCheckedAt,
  describeClaudeLoginOutcome,
  mcpStatusBadge,
  summarizeMcpStatuses,
} from "./exowattClaudeMcp.logic";

function status(
  overrides: Partial<ExowattMcpRuntimeStatus> & { name: string },
): ExowattMcpRuntimeStatus {
  return {
    transport: "http",
    enabled: true,
    authMode: "oauth",
    credential: "valid",
    needsLogin: false,
    loginInProgress: false,
    configError: null,
    connectionError: null,
    ...overrides,
  };
}

function server(name: string): ExowattMcpServer {
  return {
    id: `/tmp/.claude.json:${name}`,
    name,
    status: "enabled",
    sourcePath: "/tmp/.claude.json",
    transport: "http",
    url: `https://${name}.example/mcp`,
    args: [],
    envNames: [],
  };
}

describe("mcpStatusBadge", () => {
  it("puts reachability before credentials", () => {
    assert.deepEqual(mcpStatusBadge(status({ name: "a", connectionError: "HTTP 502" })), {
      label: "unreachable",
      variant: "destructive",
      title: "HTTP 502",
    });
    assert.equal(
      mcpStatusBadge(status({ name: "a", configError: "bad", connectionError: "x" })).label,
      "misconfigured",
    );
  });

  it("names the login states the way the Phi rows always did", () => {
    assert.equal(mcpStatusBadge(status({ name: "a" })).label, "connected");
    assert.equal(
      mcpStatusBadge(status({ name: "a", credential: "absent", needsLogin: true })).label,
      "login required",
    );
    assert.equal(
      mcpStatusBadge(status({ name: "a", credential: "expired" })).label,
      "credential expired",
    );
    assert.equal(
      mcpStatusBadge(status({ name: "a", credential: "n/a" })).label,
      "no login required",
    );
    assert.equal(
      mcpStatusBadge(status({ name: "a", expiresAt: "2026-10-01T00:00:00Z" })).title,
      "Expires 2026-10-01T00:00:00Z",
    );
  });
});

describe("claudeServersOutsideInventory", () => {
  it("returns only servers the config file does not have, sorted by display name", () => {
    const rows = claudeServersOutsideInventory({
      inventoryServers: [server("monday"), server("p3")],
      statuses: [
        status({ name: "p3" }),
        status({ name: "claude.ai Slack", managedBy: "claude.ai" }),
        status({ name: "monday" }),
        status({ name: "claude.ai Gmail", managedBy: "claude.ai" }),
        status({ name: "project-tool" }),
      ],
    });
    assert.deepEqual(
      rows.map((row) => row.name),
      ["claude.ai Gmail", "project-tool", "claude.ai Slack"],
    );
  });
});

describe("summarizeMcpStatuses", () => {
  it("counts connected, login-needed and unreachable servers", () => {
    assert.equal(
      summarizeMcpStatuses([
        status({ name: "a" }),
        status({ name: "b" }),
        status({ name: "c", credential: "absent", needsLogin: true }),
        status({ name: "d", credential: "n/a", connectionError: "HTTP 502" }),
      ]),
      "4 servers · 2 connected · 1 needs login · 1 unreachable",
    );
    assert.equal(summarizeMcpStatuses([]), "No servers reported.");
    assert.equal(summarizeMcpStatuses([status({ name: "a" })]), "1 server · 1 connected");
  });
});

describe("describeCheckedAt", () => {
  it("rounds to the unit a person would say", () => {
    const now = Date.parse("2026-09-17T15:00:00Z");
    assert.equal(describeCheckedAt("2026-09-17T14:59:55Z", now), "checked just now");
    assert.equal(describeCheckedAt("2026-09-17T14:59:20Z", now), "checked 40 s ago");
    assert.equal(describeCheckedAt("2026-09-17T14:57:00Z", now), "checked 3 min ago");
    assert.equal(describeCheckedAt("2026-09-17T12:00:00Z", now), "checked 3 h ago");
    assert.equal(describeCheckedAt(undefined, now), null);
    assert.equal(describeCheckedAt("garbage", now), null);
  });
});

describe("claudeRuntimeStatusLine", () => {
  const now = Date.parse("2026-09-17T15:00:00Z");

  it("explains the wait, the CLI being missing, and the answer", () => {
    assert.match(
      claudeRuntimeStatusLine({ status: undefined, pending: true, nowMs: now }),
      /take a minute/u,
    );
    assert.match(
      claudeRuntimeStatusLine({
        status: { available: false, supportsEnablement: false, servers: [] },
        pending: false,
        nowMs: now,
      }),
      /claude command was not found/u,
    );
    assert.equal(
      claudeRuntimeStatusLine({
        status: {
          available: true,
          supportsEnablement: false,
          servers: [status({ name: "a" })],
          checkedAt: "2026-09-17T14:58:00Z",
        },
        pending: true,
        nowMs: now,
      }),
      "1 server · 1 connected · checked 2 min ago · refreshing…",
    );
  });
});

describe("describeClaudeLoginOutcome", () => {
  it("treats a claude.ai hand-off as a notice, not a finished login", () => {
    assert.deepEqual(
      describeClaudeLoginOutcome({
        connected: true,
        error: null,
        authorizationUrl: "https://claude.ai/x",
        detail:
          "Once authorized on claude.ai, the connector will be available the next time you start Claude Code.",
      }),
      {
        kind: "notice",
        message:
          "Once authorized on claude.ai, the connector will be available the next time you start Claude Code.",
      },
    );
    assert.equal(describeClaudeLoginOutcome({ connected: true, error: null }).kind, "notice");
    assert.deepEqual(describeClaudeLoginOutcome({ connected: false, error: "exit 1" }), {
      kind: "error",
      message: "exit 1",
    });
  });
});
