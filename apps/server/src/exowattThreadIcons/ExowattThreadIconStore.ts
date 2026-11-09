// exowatt: per-thread Font Awesome icons, one row per picked thread. `subscribe` emits every
// row, then each upsert/removal, so an icon picked just after a subagent spawns reaches the
// sidebar without a refetch. Kept out of the v2 event log: P3-only presentation state.
import {
  ExowattThreadIconsError,
  type ExowattThreadIcon,
  type ExowattThreadIconsStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

const IconRow = Schema.Struct({
  threadId: ThreadId,
  icon: Schema.String,
  title: Schema.String,
  source: Schema.Literals(["generated", "fallback"]),
  updatedAt: Schema.String,
});

const storeError = (operation: string) => (cause: unknown) =>
  Effect.logWarning("Thread icon store query failed", { operation, cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new ExowattThreadIconsError({ operation, reason: "the icon store could not be read" }),
      ),
    ),
  );

type IconChange = Exclude<ExowattThreadIconsStreamEvent, { readonly type: "snapshot" }>;

export class ExowattThreadIconStore extends Context.Service<
  ExowattThreadIconStore,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ExowattThreadIcon>, ExowattThreadIconsError>;
    readonly upsert: (icon: ExowattThreadIcon) => Effect.Effect<void, ExowattThreadIconsError>;
    readonly remove: (threadId: ThreadId) => Effect.Effect<void, ExowattThreadIconsError>;
    /** Every stored icon, then each change. */
    readonly subscribe: () => Stream.Stream<ExowattThreadIconsStreamEvent, ExowattThreadIconsError>;
  }
>()("t3/exowattThreadIcons/ExowattThreadIconStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<IconChange>();

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IconRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        icon AS "icon",
        title AS "title",
        source AS "source",
        updated_at AS "updatedAt"
      FROM exowatt_thread_icons
    `,
  });

  const deleteRow = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) => sql`
      DELETE FROM exowatt_thread_icons WHERE thread_id = ${threadId}
      RETURNING thread_id AS "threadId"
    `,
  });

  const list: ExowattThreadIconStore["Service"]["list"] = () =>
    listRows(undefined).pipe(Effect.catch(storeError("list")));

  const upsert: ExowattThreadIconStore["Service"]["upsert"] = (icon) =>
    sql`
      INSERT INTO exowatt_thread_icons (thread_id, icon, title, source, updated_at)
      VALUES (${icon.threadId}, ${icon.icon}, ${icon.title}, ${icon.source}, ${icon.updatedAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        icon = excluded.icon,
        title = excluded.title,
        source = excluded.source,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.andThen(PubSub.publish(changes, { type: "upsert", icons: [icon] })),
      Effect.asVoid,
      Effect.catch(storeError("upsert")),
    );

  const remove: ExowattThreadIconStore["Service"]["remove"] = (threadId) =>
    deleteRow({ threadId }).pipe(
      Effect.tap((rows) =>
        rows.length > 0
          ? PubSub.publish(changes, { type: "remove", threadIds: [threadId] })
          : Effect.void,
      ),
      Effect.asVoid,
      Effect.catch(storeError("remove")),
    );

  const subscribe: ExowattThreadIconStore["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot read so a change landing in between is
        // replayed after it; upserts are idempotent for the folding client.
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot: ExowattThreadIconsStreamEvent = { type: "snapshot", icons: yield* list() };
        return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
      }),
    );

  return ExowattThreadIconStore.of({ list, upsert, remove, subscribe });
});

export const layer = Layer.effect(ExowattThreadIconStore, make);
