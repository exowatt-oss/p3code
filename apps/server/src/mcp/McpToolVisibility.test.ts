import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentId,
  type ExowattPeerInbound,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { HttpServerResponse } from "effect/http";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpToolVisibility from "./McpToolVisibility.ts";

const environmentId = EnvironmentId.make("environment-visibility-test");

const providerScope = (
  capabilities: McpInvocationScope["capabilities"] = new Set(["preview", "orchestration"]),
): McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities,
  issuedAt: 0,
});

const session = (scopes: ReadonlyArray<string>, clientLabel?: string) =>
  ({
    sessionId: AuthSessionId.make("session-agent"),
    subject: "claude-code",
    scopes,
    ...(clientLabel === undefined ? {} : { clientLabel }),
  }) as never;

/** A forward peer session's label: minted by this server on an environment it already trusts. */
const peerScope = (peerInbound: ExowattPeerInbound = "full-access") => {
  const scope = McpToolVisibility.environmentSessionMcpScope({
    environmentId,
    session: session([AuthOrchestrationOperateScope], "p3-peer:Mac (environment-mac)"),
    issuedAt: 1,
    peerInbound,
  });
  if (typeof scope === "string") throw new Error("expected a scope");
  return scope;
};

/** A reverse (receiver-gated) peer session's label: stored on this server by its primary. */
const reversePeerScope = (peerInbound?: ExowattPeerInbound) => {
  const scope = McpToolVisibility.environmentSessionMcpScope({
    environmentId,
    session: session([AuthOrchestrationOperateScope], "p3-peer:reverse Mac (environment-mac)"),
    issuedAt: 1,
    ...(peerInbound === undefined ? {} : { peerInbound }),
  });
  if (typeof scope === "string") throw new Error("expected a scope");
  return scope;
};

const toolsList = (names: ReadonlyArray<string>) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: names.map((name) => ({ name, inputSchema: {} })) },
  });

const listedNames = (text: string | null) =>
  text === null
    ? null
    : (JSON.parse(text) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      );

describe("environment-session MCP principal", () => {
  it("needs the operate scope and then holds only command-center", () => {
    assert.strictEqual(
      McpToolVisibility.environmentSessionMcpScope({
        environmentId,
        session: session(["orchestration:read"]),
        issuedAt: 1,
      }),
      "insufficient_scope",
    );
    const scope = McpToolVisibility.environmentSessionMcpScope({
      environmentId,
      session: session([AuthOrchestrationOperateScope]),
      issuedAt: 1,
    });
    assert.notStrictEqual(scope, "insufficient_scope");
    if (typeof scope === "string") return;
    assert.deepStrictEqual([...scope.capabilities], ["command-center"]);
    assert.deepStrictEqual(scope.environmentSession, {
      sessionId: AuthSessionId.make("session-agent"),
      subject: "claude-code",
    });
  });

  it("marks a session whose label starts with p3-peer: as a linked environment's, forward or reverse", () => {
    assert.strictEqual(peerScope().environmentSession?.peer, true);
    assert.strictEqual(reversePeerScope("full-access").environmentSession?.peer, true);
    const ordinary = McpToolVisibility.environmentSessionMcpScope({
      environmentId,
      session: session([AuthOrchestrationOperateScope], "Claude Code on my laptop"),
      issuedAt: 1,
    });
    assert.notStrictEqual(ordinary, "insufficient_scope");
    if (typeof ordinary === "string") return;
    assert.isUndefined(ordinary.environmentSession?.peer);
  });

  it("admits a forward peer session with no ceiling, whatever this server's inbound setting is", () => {
    for (const peerInbound of [undefined, "off", "approval-required", "full-access"] as const) {
      const scope = McpToolVisibility.environmentSessionMcpScope({
        environmentId,
        session: session([AuthOrchestrationOperateScope], "p3-peer:Mac (environment-mac)"),
        issuedAt: 1,
        ...(peerInbound === undefined ? {} : { peerInbound }),
      });
      if (typeof scope === "string") throw new Error(`forward peer refused with ${scope}`);
      assert.strictEqual(scope.environmentSession?.peer, true);
      assert.isUndefined(scope.environmentSession?.gated);
      assert.isUndefined(scope.environmentSession?.peerCeiling);
    }
  });

  it("admits a reverse (gated) peer session only while this server's inbound setting is on", () => {
    const scopeFor = (peerInbound?: ExowattPeerInbound) =>
      McpToolVisibility.environmentSessionMcpScope({
        environmentId,
        session: session([AuthOrchestrationOperateScope], "p3-peer:reverse Mac (environment-mac)"),
        issuedAt: 1,
        ...(peerInbound === undefined ? {} : { peerInbound }),
      });
    assert.strictEqual(scopeFor("off"), "peer_inbound_off");
    assert.strictEqual(scopeFor(), "peer_inbound_off");
    const admitted = reversePeerScope("auto-accept-edits");
    assert.strictEqual(admitted.environmentSession?.peer, true);
    assert.strictEqual(admitted.environmentSession?.gated, true);
    assert.strictEqual(admitted.environmentSession?.peerCeiling, "auto-accept-edits");
    const ordinary = McpToolVisibility.environmentSessionMcpScope({
      environmentId,
      session: session([AuthOrchestrationOperateScope], "Claude Code on my laptop"),
      issuedAt: 1,
      peerInbound: "off",
    });
    assert.notStrictEqual(typeof ordinary, "string");
  });

  it("gives provider sessions command-center only while an agent-tool setting is on", () => {
    assert.isFalse(
      McpToolVisibility.providerSessionsGetCommandCenter({
        enableAgentThreadTools: false,
        enableAgentP3Tools: false,
      }),
    );
    assert.isTrue(
      McpToolVisibility.providerSessionsGetCommandCenter({
        enableAgentThreadTools: false,
        enableAgentP3Tools: true,
      }),
    );
    const widened = McpToolVisibility.withCommandCenter(providerScope());
    assert.deepStrictEqual([...widened.capabilities].toSorted(), [
      "command-center",
      "orchestration",
      "preview",
    ]);
  });
});

describe("tools/list visibility", () => {
  const upstream = ["t3_thread_list", "preview_snapshot", "device_list"];
  const p3 = ["thread_list", "thread_focus", "settings_get"];
  const listing = toolsList([...upstream, ...p3]);

  it("shows an environment session only the P3 toolkits", () => {
    const scope = McpToolVisibility.makeEnvironmentSessionScope({
      environmentId,
      sessionId: AuthSessionId.make("session-agent"),
      subject: "claude-code",
      issuedAt: 0,
    });
    assert.deepStrictEqual(
      listedNames(McpToolVisibility.filterMcpToolsListJson(scope, listing)),
      p3,
    );
  });

  it("shows a linked environment's session only the cross-environment Threads tools", () => {
    const listed = listedNames(
      McpToolVisibility.filterMcpToolsListJson(
        peerScope(),
        toolsList([
          ...upstream,
          ...p3,
          "thread_delete",
          "thread_status",
          "thread_create",
          "environment_list",
          "harness_mcp_add",
          "provider_update",
          "settings_update",
        ]),
      ),
    );
    assert.deepStrictEqual(listed, [
      "thread_list",
      "thread_status",
      "thread_create",
      "environment_list",
    ]);
  });

  it("shows a provider session the P3 toolkits only with command-center", () => {
    assert.deepStrictEqual(
      listedNames(McpToolVisibility.filterMcpToolsListJson(providerScope(), listing)),
      upstream,
    );
    const widened = McpToolVisibility.withCommandCenter(providerScope());
    assert.strictEqual(McpToolVisibility.filterMcpToolsListJson(widened, listing), null);
  });

  it("leaves other responses untouched", () => {
    const scope = providerScope();
    assert.strictEqual(
      McpToolVisibility.filterMcpToolsListJson(scope, '{"jsonrpc":"2.0","id":1,"result":{}}'),
      null,
    );
    const response = HttpServerResponse.text("event: message", {
      contentType: "text/event-stream",
    });
    assert.strictEqual(McpToolVisibility.filterMcpToolsListResponse(scope, response), response);
    const filtered = McpToolVisibility.filterMcpToolsListResponse(
      scope,
      HttpServerResponse.text(listing, { contentType: "application/json" }),
    );
    assert.strictEqual(filtered.body._tag, "Uint8Array");
    if (filtered.body._tag !== "Uint8Array") return;
    assert.deepStrictEqual(listedNames(new TextDecoder().decode(filtered.body.body)), upstream);
  });
});

describe("tools/call gate", () => {
  it("refuses a linked environment's session everything outside its allowlist", () => {
    for (const tool of ["settings_update", "thread_delete", "harness_mcp_add", "t3_thread_list"]) {
      assert.include(
        McpToolVisibility.mcpToolCallRefusal(peerScope(), tool, {}) ?? "",
        "not available to a linked environment",
        tool,
      );
    }
    assert.isNull(McpToolVisibility.mcpToolCallRefusal(peerScope(), "thread_status", {}));
    assert.isNull(McpToolVisibility.mcpToolCallRefusal(peerScope(), "environment_list", {}));
  });

  it("refuses environmentId on a Threads tool that only acts locally", () => {
    const agent = McpToolVisibility.makeEnvironmentSessionScope({
      environmentId,
      sessionId: AuthSessionId.make("session-agent"),
      subject: "claude-code",
      issuedAt: 0,
    });
    const args = { threadId: "thread-1", environmentId: "environment-devbox" };
    assert.include(
      McpToolVisibility.mcpToolCallRefusal(agent, "thread_delete", args) ?? "",
      "does not take environmentId",
    );
    assert.isNull(
      McpToolVisibility.mcpToolCallRefusal(agent, "thread_delete", { threadId: "thread-1" }),
    );
    assert.isNull(McpToolVisibility.mcpToolCallRefusal(agent, "thread_status", args));
    // Upstream tools keep their own argument handling.
    assert.isNull(McpToolVisibility.mcpToolCallRefusal(providerScope(), "t3_thread_read", args));
  });
});
