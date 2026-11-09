import {
  AuthSessionId,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ExowattThreadHubStore from "../../../exowattThreadHub/ExowattThreadHubStore.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../../../persistence/Migrations.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { makeEnvironmentSessionScope } from "../../McpToolVisibility.ts";
import { threadHubHandlers } from "./handlers.ts";

const KNOWN_THREAD = ThreadId.make("thread-hub-known");

const scope = (capabilities: ReadonlyArray<"command-center">): McpInvocationScope => ({
  ...makeEnvironmentSessionScope({
    environmentId: EnvironmentId.make("environment-thread-hub-test"),
    sessionId: AuthSessionId.make("session-1"),
    subject: "agent",
    issuedAt: 1,
  }),
  capabilities: new Set(capabilities),
});

// The handler only asks whether the thread exists; the shell's fields are irrelevant.
const KNOWN_SHELL = { id: KNOWN_THREAD, deletedAt: null } as unknown as OrchestrationV2ThreadShell;

const layerFor = (invocation: McpInvocationScope) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext, invocation),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(threadId === KNOWN_THREAD ? KNOWN_SHELL : null),
    }),
    ExowattThreadHubStore.layer.pipe(
      Layer.provideMerge(Layer.effectDiscard(runMigrations())),
      Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );

const storedEntries = Effect.gen(function* () {
  const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
  return (yield* store.get({ threadId: KNOWN_THREAD })).entries;
});

describe("thread Hub toolkit", () => {
  it.effect("pins a derived item and adds a note by hand", () =>
    Effect.gen(function* () {
      yield* threadHubHandlers.thread_hub_pin({
        threadId: KNOWN_THREAD,
        kind: "link-output",
        key: "https://example.com/report",
        pinned: true,
      });
      const note = yield* threadHubHandlers.thread_hub_pin({
        threadId: KNOWN_THREAD,
        kind: "note-output",
        key: "note:handoff",
        title: "Handoff",
        note: "Deploy is green; Alex owns the rollback.",
      });
      assert.deepStrictEqual(note.entry?.manual, {
        title: "Handoff",
        note: "Deploy is green; Alex owns the rollback.",
      });
      assert.deepStrictEqual(
        (yield* storedEntries).map((entry) => [entry.kind, entry.pinned, entry.manual !== null]),
        [
          ["link-output", true, false],
          ["note-output", false, true],
        ],
      );
    }).pipe(Effect.provide(layerFor(scope(["command-center"])))),
  );

  it.effect("needs a title to add something by hand", () =>
    Effect.gen(function* () {
      const error = yield* threadHubHandlers
        .thread_hub_pin({
          threadId: KNOWN_THREAD,
          kind: "note-source",
          key: "note:1",
          note: "orphan",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ThreadHubToolError");
      assert.deepStrictEqual(yield* storedEntries, []);
    }).pipe(Effect.provide(layerFor(scope(["command-center"])))),
  );

  it.effect("refuses a thread that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* threadHubHandlers
        .thread_hub_pin({
          threadId: ThreadId.make("thread-missing"),
          kind: "file-output",
          key: "a.md",
          pinned: true,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.threadId, "thread-missing");
    }).pipe(Effect.provide(layerFor(scope(["command-center"])))),
  );

  it.effect("refuses a credential without the command-center capability", () =>
    Effect.gen(function* () {
      const error = yield* threadHubHandlers
        .thread_hub_pin({ threadId: KNOWN_THREAD, kind: "file-output", key: "a.md", pinned: true })
        .pipe(Effect.flip);
      assert.strictEqual(error.threadId, null);
      assert.deepStrictEqual(yield* storedEntries, []);
    }).pipe(Effect.provide(layerFor(scope([])))),
  );
});
