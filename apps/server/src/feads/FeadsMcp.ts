/**
 * The feads MCP door, called from the server. The dashboard's `/api/*` routes cannot read one
 * bead's long-form fields or post a comment, so "Open as P3 thread" uses feads' own `/mcp`
 * (`show`, `comments`, `comment`) with the same bearer token. Nothing here fails the caller.
 *
 * @module FeadsMcp
 */
import * as Effect from "effect/Effect";

import { redactFeadsSecrets } from "./FeadsConfig.ts";
import * as FeadsHttp from "./FeadsHttp.ts";

/** Where the dashboard proxies feads' MCP server. */
export const FEADS_MCP_PATH = "/mcp";
/** The revision P3 speaks; feads answers `2025-06-18`. */
export const FEADS_MCP_PROTOCOL_VERSION = "2025-06-18";
/** Both types, or the door answers 406. */
const MCP_ACCEPT = "application/json, text/event-stream";

export interface FeadsMcpTarget {
  readonly baseUrl: string;
  readonly token: string;
}

export interface FeadsMcpCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type FeadsMcpOutcome =
  | {
      readonly kind: "ok";
      /** The tool's text block, joined; feads returns JSON in it for reads. */
      readonly text: string;
      /** That text parsed as JSON when it is JSON, else `null`. */
      readonly json: unknown;
    }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Read a streamable-HTTP body. A JSON-RPC response arrives either as plain
 * JSON or as an SSE stream; in the latter case the payload is the last `data:`
 * line, which is the only one for a single request.
 */
export function parseMcpBody(text: string): unknown {
  const direct = FeadsHttp.parseFeadsJson(text);
  if (direct !== null) return direct;
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => FeadsHttp.parseFeadsJson(line.slice("data:".length)))
    .filter((payload) => payload !== null);
  return payloads.length === 0 ? null : payloads[payloads.length - 1];
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * JSON-RPC payload → what the tool said. Transport-level errors, tool errors
 * (`isError`) and unreadable shapes all become `failed` with feads' own words
 * where it gave any.
 */
export function mcpToolOutcome(payload: unknown): FeadsMcpOutcome {
  const envelope = record(payload);
  if (envelope === null) return { kind: "failed", error: "mcp_unexpected_shape" };
  const rpcError = record(envelope.error);
  if (rpcError !== null) {
    const message = typeof rpcError.message === "string" ? rpcError.message.trim() : "";
    return { kind: "failed", error: message.length > 0 ? message : "mcp_error" };
  }
  const result = record(envelope.result);
  if (result === null) return { kind: "failed", error: "mcp_unexpected_shape" };
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((part) => {
      const block = record(part);
      return block !== null && typeof block.text === "string" ? block.text : "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
  if (result.isError === true) {
    return { kind: "failed", error: text.length > 0 ? text : "tool_error" };
  }
  const parsed = FeadsHttp.parseFeadsJson(text);
  // FastMCP wraps a non-object return in `{ result: … }`; the text block is the
  // same value unwrapped, so it is preferred and this is only the fallback.
  const structured = record(result.structuredContent);
  const json =
    parsed ??
    (structured === null ? null : "result" in structured ? structured.result : structured);
  return { kind: "ok", text, json };
}

const failureFrom = (status: number, payload: unknown): string => {
  if (status === 401 || status === 403) return "not_identified";
  if (status === 404) return "mcp_unavailable";
  const envelope = record(payload);
  const rpcError = envelope === null ? null : record(envelope.error);
  const message =
    rpcError !== null && typeof rpcError.message === "string" ? rpcError.message.trim() : "";
  return message.length > 0 ? message : `http_${status}`;
};

/**
 * Run `calls` against feads' MCP door in one session, in order.
 *
 * A handshake that does not complete is reported once per call, so a caller
 * never has to distinguish "the session never opened" from "the tool refused".
 */
export const callFeadsMcpTools: (
  target: FeadsMcpTarget,
  calls: ReadonlyArray<FeadsMcpCall>,
) => Effect.Effect<ReadonlyArray<FeadsMcpOutcome>, never, FeadsHttp.FeadsHttpClient> = Effect.fn(
  "FeadsMcp.callFeadsMcpTools",
)(function* (target, calls) {
  const http = yield* FeadsHttp.FeadsHttpClient;
  const url = `${target.baseUrl.replace(/\/+$/, "")}${FEADS_MCP_PATH}`;
  const post = (body: unknown, sessionId: string | null) =>
    http
      .request({
        method: "POST",
        url,
        token: target.token,
        body,
        headers: {
          accept: MCP_ACCEPT,
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        },
      })
      .pipe(
        Effect.map((response) => ({
          status: response.status,
          headers: response.headers,
          payload: parseMcpBody(response.text),
        })),
        Effect.catch((error) =>
          Effect.succeed({
            status: 0,
            headers: {} as Readonly<Record<string, string>>,
            payload: null as unknown,
            transport: redactFeadsSecrets(`${error.reason}: ${error.detail}`),
          }),
        ),
      );
  const allFailed = (error: string): ReadonlyArray<FeadsMcpOutcome> =>
    calls.map(() => ({ kind: "failed", error }) as const);

  if (calls.length === 0) return [];

  const handshake = yield* post(
    {
      jsonrpc: "2.0",
      id: "p3-initialize",
      method: "initialize",
      params: {
        protocolVersion: FEADS_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "p3-code", version: "1" },
      },
    },
    null,
  );
  if ("transport" in handshake) return allFailed(handshake.transport);
  if (handshake.status < 200 || handshake.status >= 300) {
    return allFailed(failureFrom(handshake.status, handshake.payload));
  }
  const sessionId = handshake.headers["mcp-session-id"] ?? null;
  if (sessionId !== null) {
    // Fire and forget: feads answers 202 and nothing depends on the body.
    yield* post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  }

  const outcomes: Array<FeadsMcpOutcome> = [];
  for (const call of calls) {
    const response = yield* post(
      {
        jsonrpc: "2.0",
        id: `p3-${call.name}`,
        method: "tools/call",
        params: { name: call.name, arguments: call.arguments },
      },
      sessionId,
    );
    if ("transport" in response) {
      outcomes.push({ kind: "failed", error: response.transport });
      continue;
    }
    outcomes.push(
      response.status >= 200 && response.status < 300
        ? mcpToolOutcome(response.payload)
        : { kind: "failed", error: failureFrom(response.status, response.payload) },
    );
  }
  return outcomes;
});
