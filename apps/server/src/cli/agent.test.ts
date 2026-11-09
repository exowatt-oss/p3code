import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  AGENT_TOKEN_ORIGIN_PLACEHOLDER,
  agentMcpServerEntry,
  formatAgentTokenOutput,
} from "./agent.ts";

const expiresAt = DateTime.makeUnsafe("2026-10-04T15:00:00.000Z");

describe("t3 agent token output", () => {
  it("prints a Cursor mcp.json entry pointing at the running server's /mcp", () => {
    const output = formatAgentTokenOutput({
      sessionId: "sess_1",
      token: "tok_abc",
      label: "cursor",
      expiresAt,
      origin: "http://127.0.0.1:3773",
      client: "cursor",
    });
    assert.include(output, 'Issued agent token "cursor" (session sess_1)');
    assert.include(output, "t3 auth session revoke sess_1");
    assert.include(output, "Add to .cursor/mcp.json");
    assert.include(output, '"url": "http://127.0.0.1:3773/mcp"');
    assert.include(output, '"Authorization": "Bearer tok_abc"');
    assert.notInclude(output, '"type"');
  });

  it("spells out the http transport for Claude Code and flags a missing server", () => {
    const entry = agentMcpServerEntry({ origin: null, token: "tok", client: "claude-code" });
    assert.deepStrictEqual(entry, {
      type: "http",
      url: `${AGENT_TOKEN_ORIGIN_PLACEHOLDER}/mcp`,
      headers: { Authorization: "Bearer tok" },
    });
    const output = formatAgentTokenOutput({
      sessionId: "sess_2",
      token: "tok",
      label: "claude-code",
      expiresAt,
      origin: null,
      client: "claude-code",
    });
    assert.include(output, "Add to .mcp.json");
    assert.include(output, "No running P3 Code server was found");
  });

  it("emits machine-readable json for scripts", () => {
    const parsed = JSON.parse(
      formatAgentTokenOutput({
        sessionId: "sess_3",
        token: "tok",
        label: "script",
        expiresAt,
        origin: "http://127.0.0.1:3773",
        client: "json",
      }),
    ) as {
      readonly sessionId: string;
      readonly token: string;
      readonly label: string;
      readonly expiresAt: string;
      readonly origin: string;
      readonly mcpServers: { readonly p3: { readonly url: string } };
    };
    assert.strictEqual(parsed.sessionId, "sess_3");
    assert.strictEqual(parsed.token, "tok");
    assert.strictEqual(parsed.label, "script");
    assert.strictEqual(parsed.expiresAt, "2026-10-04T15:00:00.000Z");
    assert.strictEqual(parsed.origin, "http://127.0.0.1:3773");
    assert.strictEqual(parsed.mcpServers.p3.url, "http://127.0.0.1:3773/mcp");
  });
});
