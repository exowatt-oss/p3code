import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as FeadsHttp from "./FeadsHttp.ts";
import { callFeadsMcpTools, mcpToolOutcome, parseMcpBody } from "./FeadsMcp.ts";

const sse = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

const toolResult = (text: string) => ({
  jsonrpc: "2.0",
  id: "p3-show",
  result: { content: [{ type: "text", text }], isError: false },
});

describe("parseMcpBody", () => {
  it("reads a plain JSON body", () => {
    expect(parseMcpBody('{"jsonrpc":"2.0","id":1}')).toEqual({ jsonrpc: "2.0", id: 1 });
  });

  it("reads the payload out of an SSE frame", () => {
    expect(parseMcpBody(sse({ ok: true }))).toEqual({ ok: true });
  });

  it("takes the last frame when the door sent several, and tolerates junk", () => {
    expect(parseMcpBody(`${sse({ n: 1 })}${sse({ n: 2 })}`)).toEqual({ n: 2 });
    expect(parseMcpBody("event: ping\n\n")).toBeNull();
    expect(parseMcpBody("")).toBeNull();
  });
});

describe("mcpToolOutcome", () => {
  it("parses the tool's text block as JSON when it is JSON", () => {
    const outcome = mcpToolOutcome(toolResult('{"id":"demo-oru","title":"Open a bead"}'));
    expect(outcome).toEqual({
      kind: "ok",
      text: '{"id":"demo-oru","title":"Open a bead"}',
      json: { id: "demo-oru", title: "Open a bead" },
    });
  });

  it("keeps a prose result as text with no JSON", () => {
    expect(mcpToolOutcome(toolResult("Comment added to demo-oru"))).toEqual({
      kind: "ok",
      text: "Comment added to demo-oru",
      json: null,
    });
  });

  it("unwraps FastMCP's structuredContent when there is no text block", () => {
    const outcome = mcpToolOutcome({
      jsonrpc: "2.0",
      id: "p3-show",
      result: { content: [], structuredContent: { result: { id: "demo-oru" } } },
    });
    expect(outcome).toEqual({ kind: "ok", text: "", json: { id: "demo-oru" } });
  });

  it("reports a tool error, a JSON-RPC error and an unreadable payload", () => {
    expect(
      mcpToolOutcome({
        jsonrpc: "2.0",
        id: "p3-comment",
        result: { content: [{ type: "text", text: "issue not found" }], isError: true },
      }),
    ).toEqual({ kind: "failed", error: "issue not found" });
    expect(
      mcpToolOutcome({ jsonrpc: "2.0", id: "x", error: { code: -32600, message: "no session" } }),
    ).toEqual({ kind: "failed", error: "no session" });
    expect(mcpToolOutcome("nope")).toEqual({ kind: "failed", error: "mcp_unexpected_shape" });
  });
});

describe("callFeadsMcpTools", () => {
  const target = { baseUrl: "http://127.0.0.1:3000", token: "fdsa_test" };

  const run = (
    respond: (input: FeadsHttp.FeadsHttpRequest) => FeadsHttp.FeadsHttpFixture,
    calls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }> = [
      { name: "show", arguments: { issue_id: "demo-oru" } },
    ],
  ) => {
    const seen: FeadsHttp.FeadsHttpRequest[] = [];
    return callFeadsMcpTools(target, calls).pipe(
      Effect.provide(
        FeadsHttp.layerFromFixtures(respond, (input) => {
          seen.push(input);
        }),
      ),
      Effect.map((outcomes) => ({ outcomes, seen })),
    );
  };

  const bodyOf = (input: FeadsHttp.FeadsHttpRequest) =>
    input.body as { readonly method: string; readonly params?: { readonly name?: string } };

  it.effect("handshakes once, then calls each tool with the session id", () =>
    Effect.gen(function* () {
      const { outcomes, seen } = yield* run(
        (input) => {
          const method = bodyOf(input).method;
          if (method === "initialize") {
            return {
              status: 200,
              json: null,
              text: sse({ jsonrpc: "2.0", id: "p3-initialize", result: {} }),
              headers: { "mcp-session-id": "s-1" },
            };
          }
          if (method === "notifications/initialized") return { status: 202, json: null };
          return { status: 200, json: null, text: sse(toolResult('{"id":"demo-oru"}')) };
        },
        [
          { name: "show", arguments: { issue_id: "demo-oru" } },
          { name: "comments", arguments: { issue_id: "demo-oru" } },
        ],
      );
      expect(outcomes.map((outcome) => outcome.kind)).toEqual(["ok", "ok"]);
      expect(seen.map((input) => bodyOf(input).method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
        "tools/call",
      ]);
      expect(seen.every((input) => input.url.endsWith("/mcp"))).toBe(true);
      expect(seen.at(-1)?.headers?.["mcp-session-id"]).toBe("s-1");
      expect(seen.at(-1)?.headers?.accept).toContain("text/event-stream");
      expect(bodyOf(seen[3]!).params?.name).toBe("comments");
    }),
  );

  it.effect("reports a refused handshake once per call, and never fails", () =>
    Effect.gen(function* () {
      const refused = yield* run(
        () => ({ status: 401, json: { error: "unauthorized" } }),
        [
          { name: "show", arguments: {} },
          { name: "comments", arguments: {} },
        ],
      );
      expect(refused.outcomes).toEqual([
        { kind: "failed", error: "not_identified" },
        { kind: "failed", error: "not_identified" },
      ]);
      // Nothing was attempted past the handshake.
      expect(refused.seen).toHaveLength(1);

      const absent = yield* run(() => ({ status: 404, json: null }));
      expect(absent.outcomes).toEqual([{ kind: "failed", error: "mcp_unavailable" }]);
    }),
  );

  it.effect("does not touch the network when there is nothing to call", () =>
    Effect.gen(function* () {
      const { outcomes, seen } = yield* run(() => ({ status: 200, json: null }), []);
      expect(outcomes).toEqual([]);
      expect(seen).toEqual([]);
    }),
  );
});
