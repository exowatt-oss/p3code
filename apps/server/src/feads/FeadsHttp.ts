/**
 * The one HTTP door the feads integration uses: bearer-authenticated JSON
 * requests to the feads dashboard's `/api/*` routes. Kept behind a service so
 * the config/poller code is tested against fixtures rather than the network.
 *
 * @module FeadsHttp
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export const FEADS_HTTP_TIMEOUT = Duration.seconds(15);

export interface FeadsHttpRequest {
  /** `PUT` and `DELETE` are the runtime-presence door's; both carry a JSON body. */
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: string;
  readonly token: string;
  readonly body?: unknown;
  /**
   * Extra request headers, applied last so they win: the MCP door needs its
   * session id and an `Accept` that also allows `text/event-stream`.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FeadsHttpResponse {
  readonly status: number;
  /** Parsed JSON body, or `null` when the body was empty or not JSON (404 pages are HTML). */
  readonly json: unknown;
  /** The body verbatim — the MCP door answers with an SSE stream, not JSON. */
  readonly text: string;
  /** Lower-cased response headers; the MCP session id arrives in one. */
  readonly headers: Readonly<Record<string, string>>;
}

export class FeadsHttpError extends Schema.TaggedError<FeadsHttpError>()("FeadsHttpError", {
  url: Schema.String,
  reason: Schema.Literals(["network", "timeout"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `feads request to ${this.url} failed (${this.reason}): ${this.detail}`;
  }
}
export const isFeadsHttpError = Schema.is(FeadsHttpError);

export class FeadsHttpClient extends Context.Service<
  FeadsHttpClient,
  {
    readonly request: (input: FeadsHttpRequest) => Effect.Effect<FeadsHttpResponse, FeadsHttpError>;
  }
>()("t3/feads/FeadsHttp/FeadsHttpClient") {}

const decodeLenientJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Empty and non-JSON bodies (feads answers unknown routes with an HTML page) become `null`. */
export function parseFeadsJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return Option.getOrElse(decodeLenientJson(trimmed), () => null);
}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const request: FeadsHttpClient["Service"]["request"] = (input) => {
    const prepared = HttpClientRequest.make(input.method)(input.url).pipe(
      HttpClientRequest.bearerToken(input.token),
      HttpClientRequest.acceptJson,
      input.body === undefined
        ? (self: HttpClientRequest.HttpClientRequest) => self
        : HttpClientRequest.bodyJsonUnsafe(input.body),
      input.headers === undefined
        ? (self: HttpClientRequest.HttpClientRequest) => self
        : HttpClientRequest.setHeaders(input.headers),
    );
    return httpClient.execute(prepared).pipe(
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.map(
            (text) =>
              ({
                status: response.status,
                json: parseFeadsJson(text),
                text,
                headers: response.headers,
              }) satisfies FeadsHttpResponse,
          ),
        ),
      ),
      Effect.mapError(
        (error) =>
          new FeadsHttpError({
            url: input.url,
            reason: "network",
            detail: error.message,
          }),
      ),
      Effect.timeoutOrElse({
        duration: FEADS_HTTP_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new FeadsHttpError({
              url: input.url,
              reason: "timeout",
              detail: `No response within ${Duration.toSeconds(FEADS_HTTP_TIMEOUT)}s.`,
            }),
          ),
      }),
      Effect.scoped,
    );
  };

  return FeadsHttpClient.of({ request });
});

/** Needs an `HttpClient`; `layerFetch` is the self-contained variant for the server. */
export const layer = Layer.effect(FeadsHttpClient, make);

export const layerFetch = layer.pipe(Layer.provide(FetchHttpClient.layer));

/**
 * What a fixture has to say. `text` and `headers` default to empty, so a test
 * only spells out the parts the code under test actually reads.
 */
export interface FeadsHttpFixture {
  readonly status: number;
  readonly json: unknown;
  readonly text?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Test double: answers each request from a routing function over the URL path. */
export function layerFromFixtures(
  respond: (input: FeadsHttpRequest) => FeadsHttpFixture | FeadsHttpError,
  onRequest?: (input: FeadsHttpRequest) => void,
) {
  return Layer.succeed(
    FeadsHttpClient,
    FeadsHttpClient.of({
      request: Effect.fn("FeadsHttp.fixtureRequest")(function* (input) {
        onRequest?.(input);
        const result = respond(input);
        if (isFeadsHttpError(result)) return yield* result;
        return {
          status: result.status,
          json: result.json,
          text: result.text ?? "",
          headers: result.headers ?? {},
        } satisfies FeadsHttpResponse;
      }),
    }),
  );
}
