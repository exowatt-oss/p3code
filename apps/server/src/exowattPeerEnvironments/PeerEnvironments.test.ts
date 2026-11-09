// @effect-diagnostics nodeBuiltinImport:off - the unix-socket test runs a real node:http peer on a temp socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerEnvironments from "./PeerEnvironments.ts";

const LOCAL = EnvironmentId.make("environment-mac");
const PEER = EnvironmentId.make("environment-devbox");
const TOKEN = "peer-bearer-token-secret";
const T3_HOME = "/home/me/.t3";
const LINK = {
  environmentId: PEER,
  label: "devbox",
  httpBaseUrl: "http://127.0.0.1:4100/",
  token: TOKEN,
  expiresAt: "2026-12-01T00:00:00.000Z",
};

interface SeenRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
  readonly redirect: globalThis.RequestInit["redirect"];
}

type Responder = (rpc: {
  readonly method: string;
  readonly sessionId: string | undefined;
}) => Response | "network-failure";

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
const initialized = () =>
  json(
    {
      jsonrpc: "2.0",
      id: "p3-peer-initialize",
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "p3", version: "0.9.0" } },
    },
    { headers: { "mcp-session-id": "session-1" } },
  );
const accepted = () => new Response(null, { status: 202 });
const toolAnswer = (structuredContent: unknown) =>
  json({ jsonrpc: "2.0", id: "x", result: { content: [], structuredContent } });

/** A peer that initializes normally and answers `tools/call` with `onCall`. */
const peer =
  (onCall: Responder): Responder =>
  (rpc) =>
    rpc.method === "initialize"
      ? initialized()
      : rpc.method === "notifications/initialized"
        ? accepted()
        : onCall(rpc);

const makeHarness = Effect.fn("makePeerHarness")(function* (
  options: {
    readonly enabled?: boolean;
    readonly respond?: Responder;
    readonly t3Home?: string;
  } = {},
) {
  const secrets = yield* Ref.make(new Map<string, Uint8Array>());
  const requests = yield* Ref.make<ReadonlyArray<SeenRequest>>([]);
  const respond = options.respond ?? peer(() => toolAnswer({}));

  const http = HttpClient.make((request, _url, _signal, fiber) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
      const rpc = JSON.parse(body) as { method: string };
      yield* Ref.update(requests, (seen) => [
        ...seen,
        {
          method: rpc.method,
          headers: request.headers,
          url: request.url,
          redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
        },
      ]);
      const answer = respond({ method: rpc.method, sessionId: request.headers["mcp-session-id"] });
      if (answer === "network-failure") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
        });
      }
      return HttpClientResponse.fromWeb(request, answer);
    }),
  );

  const settingsLayer = ServerSettings.layerTest({
    exowattCrossEnvironmentAgentTools: options.enabled ?? true,
  });
  const layer = PeerEnvironments.layer.pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) =>
            Ref.get(secrets).pipe(Effect.map((map) => Option.fromNullishOr(map.get(name)))),
          set: (name, value) => Ref.update(secrets, (map) => new Map(map).set(name, value)),
          remove: (name) =>
            Ref.update(secrets, (map) => {
              const next = new Map(map);
              next.delete(name);
              return next;
            }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(LOCAL),
        }),
        // PeerEnvironments reads only `baseDir`.
        Layer.succeed(ServerConfig.ServerConfig, { baseDir: options.t3Home ?? T3_HOME } as never),
      ),
    ),
  );
  const storedText = Ref.get(secrets).pipe(
    Effect.map((map) => {
      const bytes = map.get(PeerEnvironments.PEER_ENVIRONMENTS_SECRET_NAME);
      return bytes === undefined ? null : new TextDecoder().decode(bytes);
    }),
  );
  return { layer, requests, storedText };
});

const call = (tool = "thread_status") =>
  Effect.flatMap(PeerEnvironments.PeerEnvironments, (peers) =>
    peers.callTool(PEER, tool, { threadId: "thread-1" }, { timeoutMs: 60_000 }),
  );

const upsertLink = Effect.flatMap(PeerEnvironments.PeerEnvironments, (peers) => peers.upsert(LINK));

describe("PeerEnvironments store", () => {
  it.effect("keeps the token in the secret store and never in list", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const peers = yield* PeerEnvironments.PeerEnvironments;
        const stored = yield* peers.upsert(LINK);
        assert.notProperty(stored, "token");
        assert.strictEqual(stored.httpBaseUrl, "http://127.0.0.1:4100");
        const listed = yield* peers.list;
        assert.strictEqual(listed.enabled, true);
        assert.deepStrictEqual(
          listed.links.map((link) => [link.environmentId, link.label, link.lastError]),
          [[PEER, "devbox", null]],
        );
        assert.notInclude(JSON.stringify(listed), TOKEN);
        assert.include((yield* harness.storedText) ?? "", TOKEN);
        assert.deepStrictEqual(yield* peers.remove(PEER), { removed: true });
        assert.deepStrictEqual((yield* peers.list).links, []);
        assert.strictEqual(yield* harness.storedText, null);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects links that are not plain http(s) peers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const peers = yield* PeerEnvironments.PeerEnvironments;
        const reasons = [];
        for (const input of [
          { ...LINK, httpBaseUrl: "file:///etc/passwd" },
          { ...LINK, httpBaseUrl: "http://user:pw@127.0.0.1:4100" },
          { ...LINK, httpBaseUrl: "not a url" },
          { ...LINK, httpBaseUrl: "http://127.0.0.1:4100/prefix" },
          { ...LINK, httpBaseUrl: "http://127.0.0.1:4100/?next=evil" },
          { ...LINK, httpBaseUrl: "http://127.0.0.1:4100/#fragment" },
          { ...LINK, environmentId: LOCAL },
        ]) {
          const error = yield* peers.upsert(input).pipe(Effect.flip);
          reasons.push(
            error._tag === "PeerEnvironmentInvalidLinkError" ? error.reason : error._tag,
          );
        }
        assert.deepStrictEqual(reasons, [
          "unsupported_scheme",
          "credentials_in_url",
          "invalid_url",
          "not_an_origin",
          "not_an_origin",
          "not_an_origin",
          "local_environment",
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("accepts a unix: link only for a .sock directly in this server's peer directory", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const peers = yield* PeerEnvironments.PeerEnvironments;
        const socket = `unix:${T3_HOME}/peer/environment-mac-0a1b2c.sock`;
        assert.strictEqual(
          (yield* peers.upsert({ ...LINK, httpBaseUrl: socket })).httpBaseUrl,
          socket,
        );
        const reasons = [];
        for (const httpBaseUrl of [
          "unix:peer/environment-mac.sock",
          "unix:/tmp/environment-mac.sock",
          `unix:${T3_HOME}/peer/../userdata/x.sock`,
          `unix:${T3_HOME}/peer/nested/x.sock`,
          `unix:${T3_HOME}/peer/x.txt`,
          `unix:${T3_HOME}/peerx/x.sock`,
        ]) {
          const error = yield* peers.upsert({ ...LINK, httpBaseUrl }).pipe(Effect.flip);
          reasons.push(
            error._tag === "PeerEnvironmentInvalidLinkError" ? error.reason : error._tag,
          );
        }
        assert.deepStrictEqual(reasons, Array(6).fill("socket_outside_home"));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("turning the setting off drops stored links and refuses new ones", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const peers = yield* PeerEnvironments.PeerEnvironments;
        yield* peers.upsert(LINK);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ exowattCrossEnvironmentAgentTools: false });
        assert.deepStrictEqual(yield* peers.list, { enabled: false, links: [], inbound: "off" });
        assert.strictEqual(yield* harness.storedText, null);
        const refused = yield* peers.upsert(LINK).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "PeerEnvironmentsDisabledError");
        const callRefused = yield* call().pipe(Effect.flip);
        assert.strictEqual(callRefused._tag, "PeerEnvironmentsDisabledError");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("PeerEnvironments MCP client", () => {
  it.effect("initializes, echoes the session headers and returns structuredContent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ respond: peer(() => toolAnswer({ title: "Remote" })) });
      const answer = yield* Effect.gen(function* () {
        yield* upsertLink;
        return yield* call();
      }).pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(answer, {
        value: { title: "Remote" },
        label: "devbox",
        serverVersion: "0.9.0",
      });
      const requests = yield* Ref.get(harness.requests);
      assert.deepStrictEqual(
        requests.map((request) => request.method),
        ["initialize", "notifications/initialized", "tools/call"],
      );
      const toolCall = requests[2]!;
      assert.strictEqual(toolCall.url, "http://127.0.0.1:4100/mcp");
      assert.strictEqual(toolCall.headers.authorization, `Bearer ${TOKEN}`);
      assert.strictEqual(toolCall.headers["mcp-session-id"], "session-1");
      assert.strictEqual(toolCall.headers["mcp-protocol-version"], "2025-06-18");
      assert.include(toolCall.headers.accept ?? "", "text/event-stream");
      assert.deepStrictEqual(
        requests.map((request) => request.redirect),
        ["manual", "manual", "manual"],
      );
    }),
  );

  it.effect("treats a redirect as unreachable instead of following it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: () =>
          new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }),
      });
      const error = yield* Effect.gen(function* () {
        yield* upsertLink;
        return yield* call().pipe(Effect.flip);
      }).pipe(Effect.provide(harness.layer));
      assert.strictEqual(error.message, "environment devbox is unreachable (redirected)");
      assert.deepStrictEqual(
        (yield* Ref.get(harness.requests)).map((request) => request.url),
        ["http://127.0.0.1:4100/mcp"],
      );
    }),
  );

  it.effect("reads a JSON-RPC response framed as server-sent events", () =>
    Effect.gen(function* () {
      const sse = `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: "x",
        result: { content: [], structuredContent: { ok: true } },
      })}\n\n`;
      const harness = yield* makeHarness({
        respond: peer(
          () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
        ),
      });
      const answer = yield* Effect.gen(function* () {
        yield* upsertLink;
        return yield* call();
      }).pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(answer.value, { ok: true });
    }),
  );

  it.effect("re-initializes once when the peer forgot a cached session", () =>
    Effect.gen(function* () {
      let calls = 0;
      const harness = yield* makeHarness({
        respond: peer(() => {
          calls += 1;
          return calls === 2 ? new Response("unknown session", { status: 404 }) : toolAnswer({});
        }),
      });
      yield* Effect.gen(function* () {
        yield* upsertLink;
        yield* call();
        yield* call();
      }).pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(
        (yield* Ref.get(harness.requests)).map((request) => request.method),
        [
          "initialize",
          "notifications/initialized",
          "tools/call",
          "tools/call",
          "initialize",
          "notifications/initialized",
          "tools/call",
        ],
      );
    }),
  );

  it.effect("maps an expired link, an unreachable peer and a missing tool to readable errors", () =>
    Effect.gen(function* () {
      const failures: Array<string> = [];
      for (const respond of [
        peer(() => new Response("", { status: 401 })),
        (): "network-failure" => "network-failure",
        peer(() =>
          json({
            jsonrpc: "2.0",
            id: "x",
            error: { code: -32602, message: "Tool 'thread_x' not found" },
          }),
        ),
      ] satisfies ReadonlyArray<Responder>) {
        const harness = yield* makeHarness({ respond });
        const [message, listed] = yield* Effect.gen(function* () {
          yield* upsertLink;
          const error = yield* call("thread_x").pipe(Effect.flip);
          const peers = yield* PeerEnvironments.PeerEnvironments;
          return [error.message, (yield* peers.list).links[0]?.lastError] as const;
        }).pipe(Effect.provide(harness.layer));
        assert.strictEqual(listed, message);
        assert.notInclude(message, TOKEN);
        failures.push(message);
      }
      assert.deepStrictEqual(failures, [
        "link to devbox expired or was revoked; reopen the P3 desktop app to re-link",
        "environment devbox is unreachable (connection failed)",
        "devbox runs a P3 build without thread_x",
      ]);
    }),
  );

  it.effect("names the peer's inbound setting when the peer refuses linked agents", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: () => json({ error: "peer_inbound_off", message: "inbound off" }, { status: 403 }),
      });
      const error = yield* Effect.gen(function* () {
        yield* upsertLink;
        return yield* call().pipe(Effect.flip);
      }).pipe(Effect.provide(harness.layer));
      assert.strictEqual(error._tag, "PeerEnvironmentInboundOffError");
      assert.include(error.message, "Agents from my other environments may act here on devbox");
    }),
  );

  it.live("speaks MCP over a unix socket with a loopback Host and no redirects", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p3-peer-")),
      );
      const socketPath = NodePath.join(home, "peer", "environment-mac-0a1b2c.sock");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(socketPath), { mode: 0o700 }));
      const seen: Array<{ host?: string; authorization?: string; method: string }> = [];
      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string };
          seen.push({
            method: rpc.method,
            ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
            ...(request.headers.authorization === undefined
              ? {}
              : { authorization: request.headers.authorization }),
          });
          if (rpc.method === "notifications/initialized") {
            response.writeHead(202).end();
            return;
          }
          const result =
            rpc.method === "initialize"
              ? { protocolVersion: "2025-06-18", serverInfo: { name: "p3", version: "1.2.3" } }
              : { content: [], structuredContent: { title: "Mac thread" } };
          response
            .writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: "x", result }));
        });
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => server.listen(socketPath, () => resolve())),
        ),
        () =>
          Effect.promise(async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await NodeFSP.rm(home, { recursive: true, force: true });
          }),
      );
      const harness = yield* makeHarness({ t3Home: home });
      const answer = yield* Effect.gen(function* () {
        const peers = yield* PeerEnvironments.PeerEnvironments;
        yield* peers.upsert({ ...LINK, httpBaseUrl: `unix:${socketPath}` });
        return yield* call();
      }).pipe(Effect.provide(harness.layer));
      assert.deepStrictEqual(answer, {
        value: { title: "Mac thread" },
        label: "devbox",
        serverVersion: "1.2.3",
      });
      assert.deepStrictEqual(
        seen.map((entry) => entry.method),
        ["initialize", "notifications/initialized", "tools/call"],
      );
      for (const entry of seen) {
        assert.strictEqual(entry.host, "127.0.0.1");
        assert.strictEqual(entry.authorization, `Bearer ${TOKEN}`);
      }
      assert.deepStrictEqual(yield* Ref.get(harness.requests), []);
    }).pipe(Effect.scoped),
  );

  it.live("sends nothing to a socket in a shared directory or behind a symlink", () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p3-peer-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const directory = NodePath.join(home, "peer");
      yield* Effect.promise(() => NodeFSP.mkdir(directory, { mode: 0o700 }));
      const realSocket = NodePath.join(home, "real.sock");
      let received = 0;
      const server = NodeHttp.createServer((_request, response) => {
        received += 1;
        response.writeHead(500).end();
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => server.listen(realSocket, () => resolve())),
        ),
        () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const post = (socketPath: string) =>
        PeerEnvironments.postOverSocket({ socketPath, token: TOKEN, headers: {}, body: {} }).pipe(
          Effect.flip,
        );

      const linked = NodePath.join(directory, "environment-mac-0a1b2c.sock");
      yield* Effect.promise(() => NodeFSP.symlink(realSocket, linked));
      const symlinked = yield* post(linked);
      assert.isTrue(PeerEnvironments.isUnsafePeerSocketError(symlinked));
      assert.strictEqual(symlinked.message, "unsafe socket");

      yield* Effect.promise(() => NodeFSP.chmod(home, 0o755));
      const shared = yield* post(realSocket);
      assert.isTrue(PeerEnvironments.isUnsafePeerSocketError(shared));
      assert.strictEqual(shared.message, "unsafe socket directory");

      const directoryLink = NodePath.join(home, "peer-link");
      yield* Effect.promise(() => NodeFSP.symlink(directory, directoryLink));
      const viaLink = yield* post(NodePath.join(directoryLink, "environment-mac-0a1b2c.sock"));
      assert.strictEqual(viaLink.message, "unsafe socket directory");
      assert.strictEqual(received, 0);

      // The same socket from a private directory is dialled.
      yield* Effect.promise(() => NodeFSP.chmod(home, 0o700));
      yield* PeerEnvironments.postOverSocket({
        socketPath: realSocket,
        token: TOKEN,
        headers: {},
        body: {},
      });
      assert.strictEqual(received, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("passes a tool's own refusal through without marking the link", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: peer(() =>
          json({
            jsonrpc: "2.0",
            id: "x",
            result: {
              isError: true,
              content: [{ type: "text", text: "thread_status failed: thread not found" }],
            },
          }),
        ),
      });
      const [error, lastError] = yield* Effect.gen(function* () {
        yield* upsertLink;
        const failure = yield* call().pipe(Effect.flip);
        const peers = yield* PeerEnvironments.PeerEnvironments;
        return [failure, (yield* peers.list).links[0]?.lastError] as const;
      }).pipe(Effect.provide(harness.layer));
      assert.strictEqual(error.message, "on devbox: thread_status failed: thread not found");
      assert.strictEqual(lastError, null);
    }),
  );
});
