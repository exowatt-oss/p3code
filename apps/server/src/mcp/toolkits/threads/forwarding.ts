// Exowatt distro: send a Threads tool call to a linked P3 environment instead of running it
// here. The peer always runs a forwarded call locally (`environmentId` is stripped), so
// there are no multi-hop chains, and its answer is decoded with this server's own schema.
import {
  EXOWATT_THREADS_MCP_CAPABILITY,
  type EnvironmentId,
  ThreadId,
  type ThreadsForwardableToolName,
  ThreadsToolError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PeerEnvironments from "../../../exowattPeerEnvironments/PeerEnvironments.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Forwarded calls other than `thread_listen` give up after this long. */
const PEER_CALL_TIMEOUT_MS = 60_000;
/** Headroom on top of a forwarded `thread_listen`'s own wait. */
export const PEER_LISTEN_GRACE_MS = 30_000;

type ForwardableInput = { readonly environmentId?: EnvironmentId | undefined };

export interface ForwardSpec<I extends ForwardableInput, R2> {
  readonly tool: ThreadsForwardableToolName;
  readonly parameters: Schema.Codec<I, unknown>;
  readonly success: Schema.Codec<unknown, unknown>;
  readonly timeoutMs?: (input: I) => number;
  /** Rewrites the arguments before they leave, e.g. to cap `thread_create.runtimeMode`. */
  readonly prepare?: (input: I) => Effect.Effect<I, ThreadsToolError, R2>;
}

const threadIdOf = (input: unknown): ThreadId | null =>
  typeof input === "object" &&
  input !== null &&
  "threadId" in input &&
  typeof input.threadId === "string"
    ? ThreadId.make(input.threadId)
    : null;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Wrap a local handler: no `environmentId`, or this environment's own id, runs `local`
 * unchanged; a linked peer's id forwards the call there.
 */
export const forwardable = <I extends ForwardableInput, A, E, R, R2 = never>(
  spec: ForwardSpec<I, R2> & { readonly success: Schema.Codec<A, unknown> },
  local: (input: I) => Effect.Effect<A, E, R>,
) => {
  const encodeArgs = Schema.encodeEffect(spec.parameters);
  const decodeAnswer = Schema.decodeUnknownEffect(spec.success);
  const forward = Effect.fn("ThreadsToolkit.forward")(function* (
    environmentId: EnvironmentId,
    input: I,
  ): Effect.fn.Return<
    A,
    ThreadsToolError,
    | R2
    | McpInvocationContext.McpInvocationContext
    | ServerEnvironment.ServerEnvironment
    | PeerEnvironments.PeerEnvironments
  > {
    yield* Effect.annotateCurrentSpan({ tool: spec.tool, environmentId });
    const threadId = threadIdOf(input);
    const fail = (detail: string) => new ThreadsToolError({ tool: spec.tool, threadId, detail });
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has(EXOWATT_THREADS_MCP_CAPABILITY)) {
      return yield* fail(
        `MCP credential does not grant the ${EXOWATT_THREADS_MCP_CAPABILITY} capability.`,
      );
    }
    // A forwarded call arrives here with `environmentId` stripped; never forward it onward.
    if (invocation.environmentSession?.peer === true) {
      return yield* fail(
        "this credential is a link from another environment; it cannot reach environments linked here",
      );
    }
    const prepared = spec.prepare === undefined ? input : yield* spec.prepare(input);
    const args = yield* encodeArgs(prepared).pipe(
      Effect.mapError(() => fail("the arguments could not be encoded for the linked environment")),
    );
    if (!isRecord(args)) {
      return yield* fail("the arguments could not be encoded for the linked environment");
    }
    const peers = yield* PeerEnvironments.PeerEnvironments;
    const answer = yield* peers
      .callTool(environmentId, spec.tool, args, {
        timeoutMs: spec.timeoutMs?.(input) ?? PEER_CALL_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => fail(error.message)));
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    return yield* decodeAnswer(answer.value).pipe(
      Effect.mapError(() =>
        fail(
          `${answer.label} answered in a shape this environment does not understand (this environment runs ${descriptor.serverVersion}, ${answer.label} runs ${answer.serverVersion ?? "an unknown version"}); update the older one`,
        ),
      ),
    );
  });

  // Untraced: the local handler and `forward` each own their span.
  return Effect.fnUntraced(function* (
    input: I,
  ): Effect.fn.Return<
    A,
    E | ThreadsToolError,
    | R
    | R2
    | McpInvocationContext.McpInvocationContext
    | ServerEnvironment.ServerEnvironment
    | PeerEnvironments.PeerEnvironments
  > {
    const { environmentId, ...rest } = input;
    const stripped = rest as I;
    if (environmentId === undefined) return yield* local(stripped);
    const environment = yield* ServerEnvironment.ServerEnvironment;
    if (environmentId === (yield* environment.getEnvironmentId)) return yield* local(stripped);
    return yield* forward(environmentId, stripped);
  });
};
