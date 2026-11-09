import {
  AuthSessionId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ExowattThreadSignalStore from "../../../exowattThreadSignals/ExowattThreadSignalStore.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../../../persistence/Migrations.ts";
import {
  type McpCapability,
  McpInvocationContext,
  type McpInvocationScope,
} from "../../McpInvocationContext.ts";
import {
  isMcpToolVisibleToScope,
  makeEnvironmentSessionScope,
  withThreadSignals,
} from "../../McpToolVisibility.ts";
import { threadSignalsHandlers, UI_RENDER_UNAVAILABLE } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-thread-signals-test");
const CALLER = ThreadId.make("thread-signals-caller");
const OTHER = ThreadId.make("thread-signals-other");
const KNOWN = new Set<string>([CALLER, OTHER]);

const threadScope = (capabilities: ReadonlyArray<McpCapability>): McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-signals",
  thread: {
    threadId: CALLER,
    providerSessionId: "provider-session-signals",
    providerInstanceId: ProviderInstanceId.make("phi"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 0,
});

const environmentScope = (signals: boolean) =>
  withThreadSignals(
    makeEnvironmentSessionScope({
      environmentId,
      sessionId: AuthSessionId.make("session-signals"),
      subject: "claude-code",
      issuedAt: 0,
    }),
    { exowattThreadSignals: signals },
  );

const layerFor = (invocation: McpInvocationScope) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext, invocation),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          KNOWN.has(threadId)
            ? ({ id: threadId, deletedAt: null } as unknown as OrchestrationV2ThreadShell)
            : null,
        ),
    }),
    ExowattThreadSignalStore.layer.pipe(
      Layer.provideMerge(Layer.effectDiscard(runMigrations())),
      Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      Layer.provide(NodeCrypto.layer),
    ),
  );

const ON: ReadonlyArray<McpCapability> = ["command-center", "thread-signals"];

describe("thread signals toolkit", () => {
  it.effect("emits on the calling thread, lists and acks", () =>
    Effect.gen(function* () {
      const { signal } = yield* threadSignalsHandlers.t3_signal_emit({
        lane: "yellow",
        title: "Sign in to Ramp on laptop",
      });
      assert.strictEqual(signal.threadId, CALLER);
      yield* threadSignalsHandlers.t3_signal_emit({
        lane: "green",
        title: "Done",
        threadId: OTHER,
      });

      const listed = yield* threadSignalsHandlers.t3_thread_signals({ lane: "yellow" });
      assert.deepStrictEqual(
        listed.signals.map((s) => s.title),
        ["Sign in to Ramp on laptop"],
      );
      assert.deepStrictEqual(yield* threadSignalsHandlers.t3_signal_ack({ threadId: CALLER }), {
        acked: 1,
      });
      assert.deepStrictEqual(
        (yield* threadSignalsHandlers.t3_thread_signals({})).signals.map((s) => s.threadId),
        [OTHER],
      );
      const empty = yield* threadSignalsHandlers.t3_signal_ack({}).pipe(Effect.flip);
      assert.strictEqual(empty.tool, "t3_signal_ack");
    }).pipe(Effect.provide(layerFor(threadScope(ON)))),
  );

  it.effect("refuses an unknown thread", () =>
    Effect.gen(function* () {
      const error = yield* threadSignalsHandlers
        .t3_signal_emit({ lane: "red", title: "x", threadId: ThreadId.make("missing") })
        .pipe(Effect.flip);
      assert.include(error.detail, "not found");
    }).pipe(Effect.provide(layerFor(threadScope(ON)))),
  );

  it.effect("needs a thread id from a caller outside a thread", () =>
    Effect.gen(function* () {
      const error = yield* threadSignalsHandlers
        .t3_signal_emit({ lane: "green", title: "x" })
        .pipe(Effect.flip);
      assert.include(error.detail, "threadId is required");
      const { signal } = yield* threadSignalsHandlers.t3_signal_emit({
        lane: "green",
        title: "x",
        threadId: OTHER,
      });
      assert.strictEqual(signal.threadId, OTHER);
    }).pipe(Effect.provide(layerFor(environmentScope(true)))),
  );

  it.effect("refuses every tool while the setting is off", () =>
    Effect.gen(function* () {
      const errors = [
        yield* threadSignalsHandlers
          .t3_signal_emit({ lane: "green", title: "x" })
          .pipe(Effect.flip),
        yield* threadSignalsHandlers.t3_thread_signals({}).pipe(Effect.flip),
        yield* threadSignalsHandlers.t3_signal_ack({ threadId: CALLER }).pipe(Effect.flip),
      ];
      for (const error of errors) assert.include(error.detail, "exowattThreadSignals");
    }).pipe(Effect.provide(layerFor(threadScope(["command-center"])))),
  );
});

describe("t3_ui_render", () => {
  it.effect("is a no-op that stores nothing and tells the agent to use Markdown", () =>
    Effect.gen(function* () {
      const result = yield* threadSignalsHandlers.t3_ui_render({
        title: "Weekend plan",
        spec: { root: "r", elements: { r: { type: "Script", props: {} } } },
      });
      assert.deepStrictEqual(result, { message: UI_RENDER_UNAVAILABLE });
      assert.include(result.message, "plain Markdown");
      assert.deepStrictEqual((yield* threadSignalsHandlers.t3_thread_signals({})).signals, []);
    }).pipe(Effect.provide(layerFor(threadScope(ON)))),
  );
});

describe("thread signal tool visibility", () => {
  const off = threadScope(["command-center"]);
  it("lists the tools only when the setting is on", () => {
    assert.isFalse(isMcpToolVisibleToScope(off, "t3_signal_emit"));
    assert.isFalse(isMcpToolVisibleToScope(environmentScope(false), "t3_thread_signals"));
    const on = withThreadSignals(off, { exowattThreadSignals: true });
    assert.isTrue(isMcpToolVisibleToScope(on, "t3_signal_emit"));
    assert.isTrue(isMcpToolVisibleToScope(environmentScope(true), "t3_signal_ack"));
    // Other P3 tools are unaffected by the setting.
    assert.isTrue(isMcpToolVisibleToScope(off, "thread_hub_pin"));
  });

  it("needs command-center as well", () => {
    const noCommandCenter = withThreadSignals(threadScope([]), { exowattThreadSignals: true });
    assert.isFalse(isMcpToolVisibleToScope(noCommandCenter, "t3_signal_emit"));
  });
});
