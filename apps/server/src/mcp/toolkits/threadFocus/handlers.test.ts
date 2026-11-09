import {
  AuthSessionId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { makeEnvironmentSessionScope } from "../../McpToolVisibility.ts";
import { threadFocusHandlers } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-thread-focus-test");
const KNOWN_THREAD = ThreadId.make("thread-known");

const scope = (capabilities: ReadonlyArray<"command-center">): McpInvocationScope => ({
  ...makeEnvironmentSessionScope({
    environmentId: environmentId,
    sessionId: AuthSessionId.make("session-1"),
    subject: "streamdeck",
    issuedAt: 1,
  }),
  capabilities: new Set(capabilities),
});

// The handler only asks whether the thread exists; the shell's fields are irrelevant.
const KNOWN_SHELL = {
  id: KNOWN_THREAD,
  deletedAt: null,
  archivedAt: null,
} as unknown as OrchestrationV2ThreadShell;

const layerFor = (invocation: McpInvocationScope) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext, invocation),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(threadId === KNOWN_THREAD ? KNOWN_SHELL : null),
    }),
    ServerSettings.layerTest(),
  );

describe("thread focus toolkit", () => {
  it.effect("records the request with a fresh generation the clients can act on", () =>
    Effect.gen(function* () {
      const result = yield* threadFocusHandlers.thread_focus({ threadId: KNOWN_THREAD });
      assert.strictEqual(result.threadId, KNOWN_THREAD);
      assert.ok(result.requestedAt.length > 0);

      const settings = yield* ServerSettings.ServerSettingsService;
      const stored = yield* settings.getSettings;
      assert.deepStrictEqual(stored.exowattThreadFocusRequest, {
        threadId: KNOWN_THREAD,
        requestedAt: result.requestedAt,
      });
    }).pipe(Effect.provide(layerFor(scope(["command-center"])))),
  );

  it.effect("a later request replaces the earlier one whole", () =>
    Effect.gen(function* () {
      yield* threadFocusHandlers.thread_focus({ threadId: KNOWN_THREAD });
      const second = yield* threadFocusHandlers.thread_focus({ threadId: KNOWN_THREAD });
      const settings = yield* ServerSettings.ServerSettingsService;
      const stored = yield* settings.getSettings;
      assert.strictEqual(stored.exowattThreadFocusRequest.requestedAt, second.requestedAt);
    }).pipe(Effect.provide(layerFor(scope(["command-center"])))),
  );

  it.effect("refuses a thread that does not exist instead of recording it", () =>
    Effect.gen(function* () {
      const error = yield* threadFocusHandlers
        .thread_focus({ threadId: ThreadId.make("thread-missing") })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ThreadFocusToolError");
      assert.strictEqual(error.threadId, "thread-missing");
      const settings = yield* ServerSettings.ServerSettingsService;
      const stored = yield* settings.getSettings;
      assert.strictEqual(stored.exowattThreadFocusRequest.requestedAt, "");
    }).pipe(Effect.provide(layerFor(scope(["command-center"])))),
  );

  it.effect("refuses a credential without the command-center capability", () =>
    Effect.gen(function* () {
      const error = yield* threadFocusHandlers
        .thread_focus({ threadId: KNOWN_THREAD })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ThreadFocusToolError");
      assert.strictEqual(error.threadId, null);
    }).pipe(Effect.provide(layerFor(scope([])))),
  );
});
