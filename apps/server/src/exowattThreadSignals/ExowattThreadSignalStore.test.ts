import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ExowattThreadSignalStore from "./ExowattThreadSignalStore.ts";

const THREAD_A = ThreadId.make("thread-signals-a");
const THREAD_B = ThreadId.make("thread-signals-b");

const TestLayer = ExowattThreadSignalStore.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(runMigrations())),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(NodeCrypto.layer),
);

const titles = (signals: ReadonlyArray<{ readonly title: string }>) =>
  signals.map((signal) => signal.title);

describe("ExowattThreadSignalStore", () => {
  it.effect("emits, lists open signals by thread and lane, and acks them", () =>
    Effect.gen(function* () {
      const store = yield* ExowattThreadSignalStore.ExowattThreadSignalStore;
      const done = yield* store.emit({
        threadId: THREAD_A,
        lane: "green",
        title: "PR merged",
        links: ["https://github.com/o/r/pull/1"],
      });
      yield* store.emit({ threadId: THREAD_A, lane: "yellow", title: "Sign in to Ramp" });
      yield* store.emit({ threadId: THREAD_B, lane: "red", title: "Build failed", detail: "tsc" });

      assert.deepStrictEqual(done.links, ["https://github.com/o/r/pull/1"]);
      assert.strictEqual(done.ackedAt, null);
      assert.deepStrictEqual(titles(yield* store.list({})), [
        "PR merged",
        "Sign in to Ramp",
        "Build failed",
      ]);
      assert.deepStrictEqual(titles(yield* store.list({ threadId: THREAD_A, lane: "yellow" })), [
        "Sign in to Ramp",
      ]);

      assert.deepStrictEqual(yield* store.ack({ ids: [done.id] }), { acked: 1 });
      assert.deepStrictEqual(yield* store.ack({ threadId: THREAD_B }), { acked: 1 });
      // Acking again changes nothing.
      assert.deepStrictEqual(yield* store.ack({ threadId: THREAD_B }), { acked: 0 });
      assert.deepStrictEqual(yield* store.ack({}), { acked: 0 });

      assert.deepStrictEqual(titles(yield* store.list({})), ["Sign in to Ramp"]);
      const all = yield* store.list({ includeAcked: true });
      assert.deepStrictEqual(
        all.map((signal) => [signal.title, signal.ackedAt !== null]),
        [
          ["PR merged", true],
          ["Sign in to Ramp", false],
          ["Build failed", true],
        ],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("skips generated-UI rows left by older builds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO exowatt_thread_signals (signal_id, thread_id, lane, title, links, ui, created_at)
        VALUES ('legacy-ui', ${THREAD_A}, 'ui', 'Old panel', '[]', '{}', '2026-01-01T00:00:00.000Z')
      `;
      const store = yield* ExowattThreadSignalStore.ExowattThreadSignalStore;
      yield* store.emit({ threadId: THREAD_A, lane: "green", title: "Done" });
      assert.deepStrictEqual(titles(yield* store.list({})), ["Done"]);
      assert.deepStrictEqual(titles(yield* store.list({ includeAcked: true })), ["Done"]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
