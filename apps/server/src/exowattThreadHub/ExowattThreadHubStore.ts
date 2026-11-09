/**
 * Exowatt: the thread Hub's per-thread overlay store. The Hub derives outputs and sources on
 * the client; this store keeps what the user did to them (pin, hide) and added by hand (a link,
 * file path, note), so every client reads the same after a restart.
 * Deliberately not part of the orchestration v2 event log: no run history depends on it.
 */
import {
  ExowattThreadHubError,
  type ExowattThreadHubDeleteInput,
  type ExowattThreadHubDeleteResult,
  type ExowattThreadHubEntry,
  type ExowattThreadHubGetInput,
  ExowattThreadHubItemKind,
  type ExowattThreadHubManual,
  type ExowattThreadHubSnapshot,
  type ExowattThreadHubUpsertInput,
  type ExowattThreadHubUpsertResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * Entries one snapshot carries. A thread with more than this many pins, hides
 * and notes is not one a person curated; the oldest are kept.
 */
const MAX_THREAD_HUB_ENTRIES = 1000;

const EntryRow = Schema.Struct({
  threadId: ThreadId,
  kind: ExowattThreadHubItemKind,
  key: Schema.String,
  pinned: Schema.Number,
  hidden: Schema.Number,
  manualTitle: Schema.NullOr(Schema.String),
  manualUrl: Schema.NullOr(Schema.String),
  manualPath: Schema.NullOr(Schema.String),
  manualNote: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type EntryRow = typeof EntryRow.Type;

const ItemRefRequest = Schema.Struct({
  threadId: ThreadId,
  kind: ExowattThreadHubItemKind,
  key: Schema.String,
});

function toEntry(row: EntryRow): ExowattThreadHubEntry {
  const manual: ExowattThreadHubManual | null =
    row.manualTitle === null
      ? null
      : {
          title: row.manualTitle,
          ...(row.manualUrl === null ? {} : { url: row.manualUrl }),
          ...(row.manualPath === null ? {} : { path: row.manualPath }),
          ...(row.manualNote === null ? {} : { note: row.manualNote }),
        };
  return {
    threadId: row.threadId,
    kind: row.kind,
    key: row.key,
    pinned: row.pinned !== 0,
    hidden: row.hidden !== 0,
    manual,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const storeError = (operation: string) => (cause: unknown) =>
  Effect.logWarning("Thread Hub store query failed", { operation, cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new ExowattThreadHubError({ operation, reason: "the Hub store could not be read" }),
      ),
    ),
  );

export class ExowattThreadHubStore extends Context.Service<
  ExowattThreadHubStore,
  {
    readonly get: (
      input: ExowattThreadHubGetInput,
    ) => Effect.Effect<ExowattThreadHubSnapshot, ExowattThreadHubError>;
    readonly upsert: (
      input: ExowattThreadHubUpsertInput,
    ) => Effect.Effect<ExowattThreadHubUpsertResult, ExowattThreadHubError>;
    readonly delete: (
      input: ExowattThreadHubDeleteInput,
    ) => Effect.Effect<ExowattThreadHubDeleteResult, ExowattThreadHubError>;
    /** The thread's entries now, then again after every change to that thread. */
    readonly subscribe: (
      input: ExowattThreadHubGetInput,
    ) => Stream.Stream<ExowattThreadHubSnapshot, ExowattThreadHubError>;
  }
>()("t3/exowattThreadHub/ExowattThreadHubStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Thread ids whose entries changed; each subscriber filters to its thread.
  const changes = yield* PubSub.unbounded<ThreadId>();

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: EntryRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        kind AS "kind",
        item_key AS "key",
        pinned AS "pinned",
        hidden AS "hidden",
        manual_title AS "manualTitle",
        manual_url AS "manualUrl",
        manual_path AS "manualPath",
        manual_note AS "manualNote",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM exowatt_thread_hub_entries
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, kind ASC, item_key ASC
      LIMIT ${MAX_THREAD_HUB_ENTRIES}
    `,
  });

  const findRow = SqlSchema.findAll({
    Request: ItemRefRequest,
    Result: EntryRow,
    execute: ({ threadId, kind, key }) => sql`
      SELECT
        thread_id AS "threadId",
        kind AS "kind",
        item_key AS "key",
        pinned AS "pinned",
        hidden AS "hidden",
        manual_title AS "manualTitle",
        manual_url AS "manualUrl",
        manual_path AS "manualPath",
        manual_note AS "manualNote",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM exowatt_thread_hub_entries
      WHERE thread_id = ${threadId} AND kind = ${kind} AND item_key = ${key}
    `,
  });

  const deleteRow = SqlSchema.findAll({
    Request: ItemRefRequest,
    Result: Schema.Struct({ key: Schema.String }),
    execute: ({ threadId, kind, key }) => sql`
      DELETE FROM exowatt_thread_hub_entries
      WHERE thread_id = ${threadId} AND kind = ${kind} AND item_key = ${key}
      RETURNING item_key AS "key"
    `,
  });

  const get: ExowattThreadHubStore["Service"]["get"] = ({ threadId }) =>
    listRows({ threadId }).pipe(
      Effect.map((rows) => ({ threadId, entries: rows.map(toEntry) })),
      Effect.catch(storeError("get")),
    );

  const upsert: ExowattThreadHubStore["Service"]["upsert"] = Effect.fn(
    "ExowattThreadHubStore.upsert",
  )(
    function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const ref = { threadId: input.threadId, kind: input.kind, key: input.key };
          const existing = (yield* findRow(ref)).map(toEntry)[0];
          const next: ExowattThreadHubEntry = {
            ...ref,
            pinned: input.pinned ?? existing?.pinned ?? false,
            hidden: input.hidden ?? existing?.hidden ?? false,
            manual: input.manual ?? existing?.manual ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          // Absent is the resting state for an overlay on a derived item.
          if (next.manual === null && !next.pinned && !next.hidden) {
            if (existing !== undefined) yield* deleteRow(ref);
            return { entry: null, changed: existing !== undefined };
          }
          yield* sql`
          INSERT INTO exowatt_thread_hub_entries (
            thread_id, kind, item_key, pinned, hidden,
            manual_title, manual_url, manual_path, manual_note,
            created_at, updated_at
          )
          VALUES (
            ${next.threadId}, ${next.kind}, ${next.key},
            ${next.pinned ? 1 : 0}, ${next.hidden ? 1 : 0},
            ${next.manual?.title ?? null}, ${next.manual?.url ?? null},
            ${next.manual?.path ?? null}, ${next.manual?.note ?? null},
            ${next.createdAt}, ${next.updatedAt}
          )
          ON CONFLICT (thread_id, kind, item_key) DO UPDATE SET
            pinned = excluded.pinned,
            hidden = excluded.hidden,
            manual_title = excluded.manual_title,
            manual_url = excluded.manual_url,
            manual_path = excluded.manual_path,
            manual_note = excluded.manual_note,
            updated_at = excluded.updated_at
        `;
          return { entry: next, changed: true };
        }),
      );
      if (result.changed) yield* PubSub.publish(changes, input.threadId);
      return { entry: result.entry };
    },
    Effect.catch(storeError("upsert")),
  );

  const remove: ExowattThreadHubStore["Service"]["delete"] = (input) =>
    deleteRow({ threadId: input.threadId, kind: input.kind, key: input.key }).pipe(
      Effect.tap((rows) =>
        rows.length > 0 ? PubSub.publish(changes, input.threadId) : Effect.void,
      ),
      Effect.map((rows) => ({ deleted: rows.length > 0 })),
      Effect.catch(storeError("delete")),
    );

  const subscribe: ExowattThreadHubStore["Service"]["subscribe"] = ({ threadId }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read so a change that lands in between is
        // not lost: at worst the same entries are emitted twice.
        const subscription = yield* PubSub.subscribe(changes);
        const latest = yield* get({ threadId });
        return Stream.concat(
          Stream.make(latest),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.mapEffect(() => get({ threadId })),
          ),
        );
      }),
    );

  return ExowattThreadHubStore.of({ get, upsert, delete: remove, subscribe });
});

export const layer = Layer.effect(ExowattThreadHubStore, make);
