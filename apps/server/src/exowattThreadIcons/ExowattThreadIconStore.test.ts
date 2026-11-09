import { assert, describe, it } from "@effect/vitest";
import { type ExowattThreadIcon, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ExowattThreadIconStore from "./ExowattThreadIconStore.ts";

const TestLayer = ExowattThreadIconStore.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(runMigrations())),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const icon = (threadId: string, name: string): ExowattThreadIcon => ({
  threadId: ThreadId.make(threadId),
  icon: name,
  title: `Title for ${threadId}`,
  source: "generated",
  updatedAt: "2026-10-04T00:00:00.000Z",
});

describe("ExowattThreadIconStore", () => {
  it.layer(TestLayer)((it) => {
    it.effect("sends a snapshot, then upserts and removals", () =>
      Effect.gen(function* () {
        const store = yield* ExowattThreadIconStore.ExowattThreadIconStore;
        yield* store.upsert(icon("thread-a", "bug"));

        const fiber = yield* store
          .subscribe()
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);
        // Let the subscriber attach before changing anything.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* store.upsert(icon("thread-b", "rocket"));
        yield* store.upsert(icon("thread-a", "flask"));
        yield* store.remove(ThreadId.make("thread-b"));
        // Removing an absent row emits nothing.
        yield* store.remove(ThreadId.make("thread-missing"));

        const events = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          Array.from(events).map((event) =>
            event.type === "remove"
              ? ["remove", ...event.threadIds]
              : [event.type, ...event.icons.map((entry) => `${entry.threadId}:${entry.icon}`)],
          ),
          [
            ["snapshot", "thread-a:bug"],
            ["upsert", "thread-b:rocket"],
            ["upsert", "thread-a:flask"],
            ["remove", "thread-b"],
          ],
        );
        assert.deepStrictEqual(
          (yield* store.list()).map((entry) => `${entry.threadId}:${entry.icon}`),
          ["thread-a:flask"],
        );
      }),
    );
  });
});
