import {
  ThreadId,
  WS_METHODS,
  WsExowattThreadHubDeleteRpc,
  WsExowattThreadHubGetRpc,
  WsExowattThreadHubSubscribeRpc,
  WsExowattThreadHubUpsertRpc,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ExowattThreadHubStore from "./ExowattThreadHubStore.ts";
import { makeThreadHubRpcHandlers } from "./rpcHandlers.ts";

const THREAD_A = ThreadId.make("thread-hub-a");
const THREAD_B = ThreadId.make("thread-hub-b");

// A fresh migrated database per test, through the real migration chain.
const TestLayer = ExowattThreadHubStore.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(runMigrations())),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const rowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM exowatt_thread_hub_entries
  `;
  return rows[0]?.count ?? 0;
});

const fileRef = (threadId: ThreadId, key = "docs/plan.md") =>
  ({ threadId, kind: "file-output", key }) as const;

/** Which part of an entry a test is about, without its timestamps. */
const shape = (entry: {
  readonly kind: string;
  readonly key: string;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly manual: unknown;
}) => ({
  kind: entry.kind,
  key: entry.key,
  pinned: entry.pinned,
  hidden: entry.hidden,
  manual: entry.manual,
});

describe("ExowattThreadHubStore", () => {
  it.effect("pins and hides a derived item, and forgets it once both are cleared", () =>
    Effect.gen(function* () {
      const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
      const pinned = yield* store.upsert({ ...fileRef(THREAD_A), pinned: true });
      assert.deepStrictEqual(pinned.entry && shape(pinned.entry), {
        kind: "file-output",
        key: "docs/plan.md",
        pinned: true,
        hidden: false,
        manual: null,
      });

      // An omitted flag keeps its stored value.
      const hidden = yield* store.upsert({ ...fileRef(THREAD_A), hidden: true });
      assert.strictEqual(hidden.entry?.pinned, true);
      assert.strictEqual(hidden.entry?.hidden, true);
      assert.strictEqual(hidden.entry?.createdAt, pinned.entry?.createdAt);

      yield* store.upsert({ ...fileRef(THREAD_A), pinned: false });
      const cleared = yield* store.upsert({ ...fileRef(THREAD_A), hidden: false });
      assert.strictEqual(cleared.entry, null);
      assert.strictEqual(yield* rowCount, 0);
      assert.deepStrictEqual((yield* store.get({ threadId: THREAD_A })).entries, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps a manual entry when it is unpinned, and deletes it on request", () =>
    Effect.gen(function* () {
      const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
      const ref = { threadId: THREAD_A, kind: "note-source", key: "note:1" } as const;
      yield* store.upsert({
        ...ref,
        pinned: true,
        manual: { title: "Ask Alex", note: "Ask Alex about the relay limits" },
      });
      const unpinned = yield* store.upsert({ ...ref, pinned: false });
      assert.deepStrictEqual(unpinned.entry && shape(unpinned.entry), {
        kind: "note-source",
        key: "note:1",
        pinned: false,
        hidden: false,
        manual: { title: "Ask Alex", note: "Ask Alex about the relay limits" },
      });

      assert.deepStrictEqual(yield* store.delete(ref), { deleted: true });
      assert.deepStrictEqual(yield* store.delete(ref), { deleted: false });
      assert.strictEqual(yield* rowCount, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps each thread's entries to itself, oldest first", () =>
    Effect.gen(function* () {
      const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
      yield* store.upsert({ ...fileRef(THREAD_A, "a.md"), pinned: true });
      yield* store.upsert({
        threadId: THREAD_A,
        kind: "link-output",
        key: "https://example.com/",
        manual: { title: "example.com", url: "https://example.com/" },
      });
      yield* store.upsert({ ...fileRef(THREAD_B, "b.md"), hidden: true });

      const a = yield* store.get({ threadId: THREAD_A });
      assert.deepStrictEqual(
        a.entries.map((entry) => entry.key),
        ["a.md", "https://example.com/"],
      );
      assert.deepStrictEqual(a.entries[1]?.manual, {
        title: "example.com",
        url: "https://example.com/",
      });
      const b = yield* store.get({ threadId: THREAD_B });
      assert.deepStrictEqual(
        b.entries.map((entry) => [entry.key, entry.hidden]),
        [["b.md", true]],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("streams the thread's entries now and after each change to that thread only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
        const received = yield* Queue.unbounded<ReadonlyArray<readonly [boolean, boolean]>>();
        yield* store.subscribe({ threadId: THREAD_A }).pipe(
          Stream.runForEach((snapshot) =>
            Queue.offer(
              received,
              snapshot.entries.map((entry) => [entry.pinned, entry.hidden] as const),
            ),
          ),
          Effect.forkScoped,
        );
        assert.deepStrictEqual(yield* Queue.take(received), []);

        yield* store.upsert({ ...fileRef(THREAD_A), pinned: true });
        assert.deepStrictEqual(yield* Queue.take(received), [[true, false]]);

        // Another thread's change is not this subscriber's business: had it
        // emitted, its snapshot would arrive ahead of the two below.
        yield* store.upsert({ ...fileRef(THREAD_B), pinned: true });
        yield* store.upsert({ ...fileRef(THREAD_A), hidden: true });
        assert.deepStrictEqual(yield* Queue.take(received), [[true, true]]);
        yield* store.upsert({ ...fileRef(THREAD_A), pinned: false });
        assert.deepStrictEqual(yield* Queue.take(received), [[false, true]]);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not publish a change for a no-op clear", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* store.subscribe({ threadId: THREAD_A }).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        // Nothing stored, nothing to clear: no emission.
        assert.strictEqual(
          (yield* store.upsert({ ...fileRef(THREAD_A), pinned: false })).entry,
          null,
        );
        yield* store.upsert({ ...fileRef(THREAD_A), hidden: true });
        const snapshots = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          snapshots.map((snapshot) => snapshot.entries.length),
          [0, 1],
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});

const ThreadHubRpcs = RpcGroup.make(
  WsExowattThreadHubGetRpc,
  WsExowattThreadHubSubscribeRpc,
  WsExowattThreadHubUpsertRpc,
  WsExowattThreadHubDeleteRpc,
);

const makeRpcClient = Effect.gen(function* () {
  const store = yield* ExowattThreadHubStore.ExowattThreadHubStore;
  return yield* RpcTest.makeClient(ThreadHubRpcs).pipe(
    Effect.provide(ThreadHubRpcs.toLayer(makeThreadHubRpcHandlers(store))),
  );
});

describe("thread Hub RPCs", () => {
  it.effect("upsert, get and delete round-trip through the WebSocket RPC contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeRpcClient;
        const added = yield* client[WS_METHODS.exowattThreadHubUpsert]({
          threadId: THREAD_A,
          kind: "file-read",
          key: "~/notes/brief.md",
          manual: { title: "brief.md", path: "~/notes/brief.md" },
        });
        assert.strictEqual(added.entry?.manual?.path, "~/notes/brief.md");

        const snapshot = yield* client[WS_METHODS.exowattThreadHubGet]({ threadId: THREAD_A });
        assert.deepStrictEqual(
          snapshot.entries.map((entry) => [entry.kind, entry.key]),
          [["file-read", "~/notes/brief.md"]],
        );

        const deleted = yield* client[WS_METHODS.exowattThreadHubDelete]({
          threadId: THREAD_A,
          kind: "file-read",
          key: "~/notes/brief.md",
        });
        assert.isTrue(deleted.deleted);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a second client's subscription sees the first client's pin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* makeRpcClient;
        const reader = yield* makeRpcClient;
        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* reader[WS_METHODS.exowattThreadHubSubscribe]({
          threadId: THREAD_A,
        }).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        yield* writer[WS_METHODS.exowattThreadHubUpsert]({
          threadId: THREAD_A,
          kind: "pull-request",
          key: "github.com/example/p3code#210",
          pinned: true,
        });
        const snapshots = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          snapshots.map((snapshot) => snapshot.entries.map((entry) => entry.key)),
          [[], ["github.com/example/p3code#210"]],
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects an unknown item kind at the contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeRpcClient;
        const exit = yield* client[WS_METHODS.exowattThreadHubUpsert]({
          threadId: THREAD_A,
          // @ts-expect-error not a Hub item kind
          kind: "subagent",
          key: "x",
          pinned: true,
        }).pipe(Effect.exit);
        assert.isTrue(exit._tag === "Failure");
        assert.strictEqual(yield* rowCount, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});
