// Exowatt distro: links to the user's other P3 environments and the MCP client that reaches
// their `/mcp`. Tokens live only in the secret store and the outbound `Authorization`
// header: never in logs, errors or reads.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's HttpClient has no unix-socket transport without undici, which the CLI bundle loads only by require.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- ownership of the socket and its directory must be checked with lstat before the bearer is sent.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- link validation is a pure, synchronous path check.
import * as NodePath from "node:path";

import {
  type EnvironmentId,
  type ExowattPeerEnvironmentLink,
  type ExowattPeerEnvironmentLinkInput,
  type ExowattPeerEnvironmentList,
  EnvironmentId as EnvironmentIdSchema,
  EXOWATT_PEER_LINK_REVOKED_PHRASE,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";

export const PEER_ENVIRONMENTS_SECRET_NAME = "exowatt-peer-environments";
const PEER_MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_ACCEPT = "application/json, text/event-stream";

// Errors.

export class PeerEnvironmentsDisabledError extends Schema.TaggedError<PeerEnvironmentsDisabledError>()(
  "PeerEnvironmentsDisabledError",
  {},
) {
  override get message(): string {
    return "Reaching other environments is off on this environment; the user turns it on in the P3 desktop app under Settings › Sharing & access (Agents reach my other environments).";
  }
}

export class PeerEnvironmentInvalidLinkError extends Schema.TaggedError<PeerEnvironmentInvalidLinkError>()(
  "PeerEnvironmentInvalidLinkError",
  {
    reason: Schema.Literals([
      "invalid_url",
      "unsupported_scheme",
      "credentials_in_url",
      "not_an_origin",
      "local_environment",
      "invalid_expiry",
      "socket_outside_home",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_url":
        return "httpBaseUrl is not a valid URL.";
      case "unsupported_scheme":
        return "httpBaseUrl must use http, https or unix.";
      case "credentials_in_url":
        return "httpBaseUrl must not carry a username or password.";
      case "not_an_origin":
        return "httpBaseUrl must be a bare origin: no path, query or fragment.";
      case "local_environment":
        return "A link cannot point at this environment itself.";
      case "invalid_expiry":
        return "expiresAt is not a valid ISO timestamp.";
      case "socket_outside_home":
        return "A unix: httpBaseUrl must name an absolute .sock path in this server's peer directory.";
    }
  }
}

export class PeerEnvironmentsStoreError extends Schema.TaggedError<PeerEnvironmentsStoreError>()(
  "PeerEnvironmentsStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to ${this.operation} the linked-environment store.`;
  }
}

export class PeerEnvironmentNotLinkedError extends Schema.TaggedError<PeerEnvironmentNotLinkedError>()(
  "PeerEnvironmentNotLinkedError",
  { environmentId: Schema.String, linkedIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    const linked = this.linkedIds.length === 0 ? "none" : this.linkedIds.join(", ");
    return `environment ${this.environmentId} is not linked to this environment (linked: ${linked}; see environment_list)`;
  }
}

export class PeerEnvironmentUnreachableError extends Schema.TaggedError<PeerEnvironmentUnreachableError>()(
  "PeerEnvironmentUnreachableError",
  { label: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `environment ${this.label} is unreachable (${this.reason})`;
  }
}

export class PeerEnvironmentLinkExpiredError extends Schema.TaggedError<PeerEnvironmentLinkExpiredError>()(
  "PeerEnvironmentLinkExpiredError",
  { label: Schema.String },
) {
  override get message(): string {
    return `link to ${this.label} ${EXOWATT_PEER_LINK_REVOKED_PHRASE}; reopen the P3 desktop app to re-link`;
  }
}

export class PeerEnvironmentForbiddenError extends Schema.TaggedError<PeerEnvironmentForbiddenError>()(
  "PeerEnvironmentForbiddenError",
  { label: Schema.String, tool: Schema.String },
) {
  override get message(): string {
    return `the link to ${this.label} does not grant the scope ${this.tool} needs; reopen the P3 desktop app to re-link`;
  }
}

/** The peer refused the session because its own inbound setting is off. */
export class PeerEnvironmentInboundOffError extends Schema.TaggedError<PeerEnvironmentInboundOffError>()(
  "PeerEnvironmentInboundOffError",
  { label: Schema.String },
) {
  override get message(): string {
    return `${this.label} does not accept agents from your other environments; turn on Settings › Sharing & access › Agents from my other environments may act here on ${this.label}`;
  }
}

export class PeerEnvironmentToolMissingError extends Schema.TaggedError<PeerEnvironmentToolMissingError>()(
  "PeerEnvironmentToolMissingError",
  { label: Schema.String, tool: Schema.String },
) {
  override get message(): string {
    return `${this.label} runs a P3 build without ${this.tool}`;
  }
}

export class PeerEnvironmentProtocolError extends Schema.TaggedError<PeerEnvironmentProtocolError>()(
  "PeerEnvironmentProtocolError",
  { label: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.label} answered with an unexpected MCP response (${this.reason})`;
  }
}

/** The peer ran the tool and it refused; `detail` is the peer's own message. */
export class PeerEnvironmentToolFailedError extends Schema.TaggedError<PeerEnvironmentToolFailedError>()(
  "PeerEnvironmentToolFailedError",
  { label: Schema.String, tool: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `on ${this.label}: ${this.detail}`;
  }
}

export type PeerEnvironmentCallError =
  | PeerEnvironmentsDisabledError
  | PeerEnvironmentsStoreError
  | PeerEnvironmentNotLinkedError
  | PeerEnvironmentUnreachableError
  | PeerEnvironmentLinkExpiredError
  | PeerEnvironmentForbiddenError
  | PeerEnvironmentInboundOffError
  | PeerEnvironmentToolMissingError
  | PeerEnvironmentProtocolError
  | PeerEnvironmentToolFailedError;

/** Failures that say something about the link itself, so `environment_list` shows them. */
type LinkFailure =
  | PeerEnvironmentUnreachableError
  | PeerEnvironmentLinkExpiredError
  | PeerEnvironmentForbiddenError
  | PeerEnvironmentInboundOffError
  | PeerEnvironmentToolMissingError
  | PeerEnvironmentProtocolError;

// Persisted shape: one JSON blob holding every link, tokens included.

const StoredLink = Schema.Struct({
  environmentId: EnvironmentIdSchema,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastError: Schema.NullOr(Schema.String),
});
type StoredLink = typeof StoredLink.Type;

const StoredLinks = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), links: Schema.Array(StoredLink) }),
);
const decodeStoredLinks = Schema.decodeUnknownOption(StoredLinks);
const encodeStoredLinks = Schema.encodeSync(StoredLinks);

const withoutToken = ({ token: _token, ...link }: StoredLink): ExowattPeerEnvironmentLink => link;

const UNIX_PREFIX = "unix:";

/** The socket path of a `unix:<absolute path>` link, or null for an http(s) one. */
export const peerSocketPath = (httpBaseUrl: string): string | null =>
  httpBaseUrl.startsWith(UNIX_PREFIX) ? httpBaseUrl.slice(UNIX_PREFIX.length) : null;

/** Where the desktop's SSH reverse forwards bind their sockets on this server. */
export const peerSocketDirectory = (t3Home: string) => NodePath.join(t3Home, "peer");

/**
 * Validate a peer origin (http(s), no userinfo, path, query or fragment) and store only the
 * origin. A `unix:` link must name a `.sock` directly in this server's own peer directory,
 * so a link can only dial the socket an SSH reverse forward bound with mode 0600.
 */
export function normalizePeerBaseUrl(
  raw: string,
  t3Home: string,
): { readonly ok: true; readonly url: string } | PeerEnvironmentInvalidLinkError {
  const socketPath = peerSocketPath(raw);
  if (socketPath !== null) {
    const directory = peerSocketDirectory(NodePath.resolve(t3Home));
    const ok =
      NodePath.isAbsolute(socketPath) &&
      NodePath.normalize(socketPath) === socketPath &&
      NodePath.dirname(socketPath) === directory &&
      /^[A-Za-z0-9_.-]+\.sock$/.test(NodePath.basename(socketPath));
    return ok
      ? { ok: true, url: `${UNIX_PREFIX}${socketPath}` }
      : new PeerEnvironmentInvalidLinkError({ reason: "socket_outside_home" });
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return new PeerEnvironmentInvalidLinkError({ reason: "invalid_url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new PeerEnvironmentInvalidLinkError({ reason: "unsupported_scheme" });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return new PeerEnvironmentInvalidLinkError({ reason: "credentials_in_url" });
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || raw.includes("#")) {
    return new PeerEnvironmentInvalidLinkError({ reason: "not_an_origin" });
  }
  return { ok: true, url: parsed.origin };
}

const decodeLenientJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const parseJson = (text: string): unknown =>
  text.trim().length === 0 ? null : Option.getOrElse(decodeLenientJson(text.trim()), () => null);

/**
 * Streamable-HTTP MCP answers a POST either as plain JSON or as an SSE stream;
 * in the latter case the payload is the last `data:` line.
 */
function parseMcpBody(text: string): unknown {
  const direct = parseJson(text);
  if (direct !== null) return direct;
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => parseJson(line.slice("data:".length)))
    .filter((payload) => payload !== null);
  return payloads.length === 0 ? null : payloads[payloads.length - 1];
}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** JSON-RPC `tools/call` payload → the tool's structured result, or why not. */
function peerToolResult(
  label: string,
  tool: string,
  payload: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | PeerEnvironmentToolMissingError
  | PeerEnvironmentProtocolError
  | PeerEnvironmentToolFailedError {
  const envelope = record(payload);
  if (envelope === null) return new PeerEnvironmentProtocolError({ label, reason: "not JSON-RPC" });
  const rpcError = record(envelope.error);
  if (rpcError !== null) {
    const message = typeof rpcError.message === "string" ? rpcError.message : "";
    if (rpcError.code === -32601 || /tool\b.*\bnot found/i.test(message)) {
      return new PeerEnvironmentToolMissingError({ label, tool });
    }
    return new PeerEnvironmentProtocolError({
      label,
      reason: `JSON-RPC error ${typeof rpcError.code === "number" ? rpcError.code : "?"}`,
    });
  }
  const result = record(envelope.result);
  if (result === null) return new PeerEnvironmentProtocolError({ label, reason: "no result" });
  if (result.isError === true) {
    const text = (Array.isArray(result.content) ? result.content : [])
      .map((part) => {
        const block = record(part);
        return block !== null && typeof block.text === "string" ? block.text : "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
    return new PeerEnvironmentToolFailedError({
      label,
      tool,
      detail: text.length > 0 ? text : `${tool} failed`,
    });
  }
  if (result.structuredContent === undefined) {
    return new PeerEnvironmentProtocolError({ label, reason: "no structuredContent" });
  }
  return { ok: true, value: result.structuredContent };
}

/** The socket or its directory failed the ownership checks; nothing was sent. */
export class UnsafePeerSocketError extends Schema.TaggedError<UnsafePeerSocketError>()(
  "UnsafePeerSocketError",
  { reason: Schema.Literals(["missing", "directory", "socket"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return "socket missing";
      case "directory":
        return "unsafe socket directory";
      case "socket":
        return "unsafe socket";
    }
  }
}

export const isUnsafePeerSocketError = Schema.is(UnsafePeerSocketError);

const lstat = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.lstat(path),
    catch: () => new UnsafePeerSocketError({ reason: "missing" }),
  });

/**
 * The bearer only goes to a socket we own, in a private directory we own: neither may be a
 * symlink, so another local user cannot swap in a listener of their own.
 */
const verifyPeerSocket = Effect.fn("PeerEnvironments.verifyPeerSocket")(function* (
  socketPath: string,
) {
  const uid = process.getuid?.();
  const directory = yield* lstat(NodePath.dirname(socketPath));
  if (
    !directory.isDirectory() ||
    (uid !== undefined && directory.uid !== uid) ||
    (directory.mode & 0o077) !== 0
  ) {
    return yield* new UnsafePeerSocketError({ reason: "directory" });
  }
  const socket = yield* lstat(socketPath);
  if (!socket.isSocket() || (uid !== undefined && socket.uid !== uid)) {
    return yield* new UnsafePeerSocketError({ reason: "socket" });
  }
});

const postOverVerifiedSocket = (input: {
  readonly socketPath: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}) =>
  Effect.callback<
    { readonly status: number; readonly sessionId: string | null; readonly text: string },
    Error
  >((resume) => {
    // @effect-diagnostics-next-line globalJsonInEffect:off -- the same JSON-RPC body `bodyJsonUnsafe` writes on the TCP route.
    const payload = JSON.stringify(input.body);
    const request = NodeHttp.request(
      {
        socketPath: input.socketPath,
        path: "/mcp",
        method: "POST",
        headers: {
          ...input.headers,
          host: "127.0.0.1",
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", (error) => resume(Effect.fail(error)));
        response.on("end", () => {
          const sessionId = response.headers["mcp-session-id"];
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              sessionId: typeof sessionId === "string" ? sessionId : null,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
      },
    );
    request.on("error", (error) => resume(Effect.fail(error)));
    request.end(payload);
    return Effect.sync(() => request.destroy());
  });

/**
 * One POST to `/mcp` over a unix socket (an SSH reverse forward), after `verifyPeerSocket`.
 * `node:http` never follows redirects, and `Host` stays loopback as for the TCP route.
 */
export const postOverSocket = (input: {
  readonly socketPath: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}) => verifyPeerSocket(input.socketPath).pipe(Effect.andThen(postOverVerifiedSocket(input)));

export interface PeerCallOptions {
  readonly timeoutMs: number;
}

export interface PeerCallResult {
  /** The tool's `structuredContent`, still in wire form. */
  readonly value: unknown;
  readonly label: string;
  /** `serverInfo.version` from the peer's `initialize`, when it sent one. */
  readonly serverVersion: string | null;
}

export class PeerEnvironments extends Context.Service<
  PeerEnvironments,
  {
    /** The setting and every stored link, without tokens. Off clears the store. */
    readonly list: Effect.Effect<ExowattPeerEnvironmentList, PeerEnvironmentsStoreError>;
    readonly upsert: (
      input: ExowattPeerEnvironmentLinkInput,
    ) => Effect.Effect<
      ExowattPeerEnvironmentLink,
      PeerEnvironmentsDisabledError | PeerEnvironmentInvalidLinkError | PeerEnvironmentsStoreError
    >;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<{ readonly removed: boolean }, PeerEnvironmentsStoreError>;
    /** Call one MCP tool on a linked peer and return its `structuredContent`. */
    readonly callTool: (
      environmentId: EnvironmentId,
      toolName: string,
      args: Readonly<Record<string, unknown>>,
      options: PeerCallOptions,
    ) => Effect.Effect<PeerCallResult, PeerEnvironmentCallError>;
  }
>()("t3/exowattPeerEnvironments/PeerEnvironments") {}

interface PeerSession {
  readonly sessionId: string | null;
  readonly protocolVersion: string;
  readonly serverVersion: string | null;
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const writeLock = yield* Semaphore.make(1);
  const sessions = yield* Ref.make(new Map<EnvironmentId, PeerSession>());

  // Read failures fail closed (disabled) but never clear: only a read `false` drops links.
  const readEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.exowattCrossEnvironmentAgentTools),
    Effect.orElseSucceed(() => null),
  );

  const readLinks = secrets.get(PEER_ENVIRONMENTS_SECRET_NAME).pipe(
    Effect.mapError((cause) => new PeerEnvironmentsStoreError({ operation: "read", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<StoredLink>>([]),
        onSome: (bytes) =>
          Option.match(decodeStoredLinks(new TextDecoder().decode(bytes)), {
            onNone: () =>
              Effect.logWarning("linked-environment store is unreadable; ignoring it").pipe(
                Effect.as<ReadonlyArray<StoredLink>>([]),
              ),
            onSome: (stored) => Effect.succeed(stored.links),
          }),
      }),
    ),
  );

  const writeLinks = (links: ReadonlyArray<StoredLink>) =>
    (links.length === 0
      ? secrets.remove(PEER_ENVIRONMENTS_SECRET_NAME)
      : secrets.set(
          PEER_ENVIRONMENTS_SECRET_NAME,
          new TextEncoder().encode(encodeStoredLinks({ version: 1, links })),
        )
    ).pipe(
      Effect.mapError((cause) => new PeerEnvironmentsStoreError({ operation: "write", cause })),
    );

  const updateLinks = (
    update: (links: ReadonlyArray<StoredLink>) => ReadonlyArray<StoredLink> | null,
  ) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const next = update(yield* readLinks);
        if (next !== null) yield* writeLinks(next);
        return next;
      }),
    );

  const clearAll = Effect.gen(function* () {
    yield* Ref.set(sessions, new Map());
    const cleared = yield* updateLinks((links) => (links.length === 0 ? null : []));
    if (cleared !== null) yield* Effect.logInfo("linking turned off; dropped linked environments");
  });

  // Unreadable settings report inbound as off, so the desktop never links into this server.
  const readInbound = settings.getSettings.pipe(
    Effect.map((current) => current.exowattPeerInbound),
    Effect.orElseSucceed(() => "off" as const),
  );

  const list: PeerEnvironments["Service"]["list"] = Effect.gen(function* () {
    const enabled = yield* readEnabled;
    const inbound = yield* readInbound;
    if (enabled === false) yield* clearAll;
    if (enabled !== true) return { enabled: false, links: [], inbound };
    return { enabled: true, links: (yield* readLinks).map(withoutToken), inbound };
  }).pipe(Effect.withSpan("PeerEnvironments.list"));

  const upsert = Effect.fn("PeerEnvironments.upsert")(function* (
    input: ExowattPeerEnvironmentLinkInput,
  ) {
    const enabled = yield* readEnabled;
    if (enabled === false) yield* clearAll;
    if (enabled !== true) return yield* new PeerEnvironmentsDisabledError();
    const normalized = normalizePeerBaseUrl(input.httpBaseUrl, baseDir);
    if (!("ok" in normalized)) return yield* normalized;
    if (input.environmentId === (yield* environment.getEnvironmentId)) {
      return yield* new PeerEnvironmentInvalidLinkError({ reason: "local_environment" });
    }
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      return yield* new PeerEnvironmentInvalidLinkError({ reason: "invalid_expiry" });
    }
    const link: StoredLink = {
      environmentId: input.environmentId,
      label: input.label,
      httpBaseUrl: normalized.url,
      token: input.token,
      linkedAt: DateTime.formatIso(yield* DateTime.now),
      expiresAt: input.expiresAt,
      lastError: null,
    };
    yield* updateLinks((links) => [
      ...links.filter((existing) => existing.environmentId !== link.environmentId),
      link,
    ]);
    yield* Ref.update(sessions, (map) => {
      const next = new Map(map);
      next.delete(link.environmentId);
      return next;
    });
    yield* Effect.annotateCurrentSpan({ environmentId: link.environmentId });
    return withoutToken(link);
  });

  const remove = Effect.fn("PeerEnvironments.remove")(function* (environmentId: EnvironmentId) {
    let removed = false;
    yield* updateLinks((links) => {
      const kept = links.filter((link) => link.environmentId !== environmentId);
      removed = kept.length !== links.length;
      return removed ? kept : null;
    });
    yield* Ref.update(sessions, (map) => {
      const next = new Map(map);
      next.delete(environmentId);
      return next;
    });
    return { removed };
  });

  const setLastError = (environmentId: EnvironmentId, lastError: string | null) =>
    updateLinks((links) =>
      links.some((link) => link.environmentId === environmentId && link.lastError !== lastError)
        ? links.map((link) =>
            link.environmentId === environmentId ? { ...link, lastError } : link,
          )
        : null,
    ).pipe(Effect.ignore);

  /** One JSON-RPC POST to the peer's `/mcp`. */
  const post = (
    link: StoredLink,
    session: PeerSession | null,
    body: unknown,
  ): Effect.Effect<
    { readonly status: number; readonly sessionId: string | null; readonly payload: unknown },
    PeerEnvironmentUnreachableError
  > => {
    const headers = {
      accept: MCP_ACCEPT,
      ...(session === null
        ? {}
        : {
            "mcp-protocol-version": session.protocolVersion,
            ...(session.sessionId === null ? {} : { "mcp-session-id": session.sessionId }),
          }),
    };
    const socketPath = peerSocketPath(link.httpBaseUrl);
    if (socketPath !== null) {
      return postOverSocket({ socketPath, token: link.token, headers, body }).pipe(
        Effect.map((response) => ({
          status: response.status,
          sessionId: response.sessionId,
          payload: parseMcpBody(response.text),
        })),
        Effect.mapError(
          (cause) =>
            new PeerEnvironmentUnreachableError({
              label: link.label,
              reason: isUnsafePeerSocketError(cause) ? cause.message : "connection failed",
              cause,
            }),
        ),
      );
    }
    return httpClient
      .execute(
        HttpClientRequest.post(new URL("/mcp", link.httpBaseUrl).toString()).pipe(
          HttpClientRequest.bearerToken(link.token),
          HttpClientRequest.bodyJsonUnsafe(body),
          HttpClientRequest.setHeaders(headers),
        ),
      )
      .pipe(
        // A redirect could carry the bearer to another origin; never follow one.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.flatMap((response) =>
          response.text.pipe(
            Effect.map((text) => ({
              status: response.status,
              sessionId: response.headers["mcp-session-id"] ?? null,
              payload: parseMcpBody(text),
            })),
          ),
        ),
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new PeerEnvironmentUnreachableError({
              label: link.label,
              reason: "connection failed",
              cause,
            }),
        ),
      );
  };

  const statusFailure = (
    link: StoredLink,
    tool: string,
    status: number,
    payload?: unknown,
  ): LinkFailure | null => {
    if (status >= 200 && status < 300) return null;
    if (status === 401) return new PeerEnvironmentLinkExpiredError({ label: link.label });
    if (status === 403 && record(payload)?.error === "peer_inbound_off") {
      return new PeerEnvironmentInboundOffError({ label: link.label });
    }
    if (status === 403) return new PeerEnvironmentForbiddenError({ label: link.label, tool });
    // `redirect: "manual"` answers a 3xx as-is in Node and as an opaque status 0 in browsers.
    if (status === 0 || (status >= 300 && status < 400)) {
      return new PeerEnvironmentUnreachableError({ label: link.label, reason: "redirected" });
    }
    return new PeerEnvironmentUnreachableError({ label: link.label, reason: `HTTP ${status}` });
  };

  const initialize = Effect.fn("PeerEnvironments.initialize")(function* (
    link: StoredLink,
    tool: string,
  ) {
    const response = yield* post(link, null, {
      jsonrpc: "2.0",
      id: "p3-peer-initialize",
      method: "initialize",
      params: {
        protocolVersion: PEER_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "p3-peer-environment", version: "1" },
      },
    });
    const failure = statusFailure(link, tool, response.status, response.payload);
    if (failure !== null) return yield* failure;
    const initResult = record(record(response.payload)?.result);
    const negotiated = initResult?.protocolVersion;
    const serverVersion = record(initResult?.serverInfo)?.version;
    const session: PeerSession = {
      sessionId: response.sessionId,
      protocolVersion: typeof negotiated === "string" ? negotiated : PEER_MCP_PROTOCOL_VERSION,
      serverVersion: typeof serverVersion === "string" ? serverVersion : null,
    };
    const initialized = yield* post(link, session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const initializedFailure = statusFailure(link, tool, initialized.status, initialized.payload);
    if (initializedFailure !== null) return yield* initializedFailure;
    yield* Ref.update(sessions, (map) => new Map(map).set(link.environmentId, session));
    return session;
  });

  const callOnce = Effect.fn("PeerEnvironments.callOnce")(function* (
    link: StoredLink,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) {
    const cached = (yield* Ref.get(sessions)).get(link.environmentId);
    const session = cached ?? (yield* initialize(link, tool));
    const body = {
      jsonrpc: "2.0",
      id: `p3-peer-${tool}`,
      method: "tools/call",
      params: { name: tool, arguments: args },
    };
    let used = session;
    let response = yield* post(link, used, body);
    // A cached session the peer forgot (restart, idle expiry): open a new one, once.
    if (cached !== undefined && (response.status === 400 || response.status === 404)) {
      used = yield* initialize(link, tool);
      response = yield* post(link, used, body);
    }
    const failure = statusFailure(link, tool, response.status, response.payload);
    if (failure !== null) return yield* failure;
    const result = peerToolResult(link.label, tool, response.payload);
    if (!("ok" in result)) return yield* result;
    return {
      value: result.value,
      label: link.label,
      serverVersion: used.serverVersion,
    } satisfies PeerCallResult;
  });

  const callTool = Effect.fn("PeerEnvironments.callTool")(function* (
    environmentId: EnvironmentId,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    options: PeerCallOptions,
  ) {
    yield* Effect.annotateCurrentSpan({ environmentId, tool: toolName });
    const enabled = yield* readEnabled;
    if (enabled === false) yield* clearAll;
    if (enabled !== true) return yield* new PeerEnvironmentsDisabledError();
    const links = yield* readLinks;
    const link = links.find((candidate) => candidate.environmentId === environmentId);
    if (link === undefined) {
      return yield* new PeerEnvironmentNotLinkedError({
        environmentId,
        linkedIds: links.map((candidate) => candidate.environmentId),
      });
    }
    const seconds = Math.ceil(options.timeoutMs / 1_000);
    return yield* callOnce(link, toolName, args).pipe(
      Effect.timeoutOrElse({
        duration: options.timeoutMs,
        orElse: () =>
          Effect.fail(
            new PeerEnvironmentUnreachableError({
              label: link.label,
              reason: `no answer within ${seconds}s`,
            }),
          ),
      }),
      Effect.tap(() => setLastError(environmentId, null)),
      // A tool's own refusal still proves the link works.
      Effect.tapError((error) =>
        setLastError(
          environmentId,
          error._tag === "PeerEnvironmentToolFailedError" ? null : error.message,
        ),
      ),
    );
  });

  // Turning the setting off drops every link now, not on the next read.
  yield* Effect.forkScoped(
    Stream.runForEach(settings.streamChanges, (next) =>
      next.exowattCrossEnvironmentAgentTools ? Effect.void : Effect.ignore(clearAll),
    ),
  );

  return PeerEnvironments.of({ list, upsert, remove, callTool });
});

/** Needs an `HttpClient`; `layerFetch` is the server's variant. */
export const layer = Layer.effect(PeerEnvironments, make);

export const layerFetch = layer.pipe(Layer.provide(FetchHttpClient.layer));
