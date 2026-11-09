/**
 * Exowatt: green/yellow/red thread signals. Agents raise, list and ack them on
 * their threads through MCP (`t3_signal_emit`, `t3_thread_signals`, `t3_signal_ack`).
 * Deliberately outside the orchestration v2 event log: no run history depends on it.
 */
import {
  type ExowattThreadSignal,
  ExowattThreadSignalLane,
  type ExowattThreadSignalsAckInput,
  type ExowattThreadSignalsAckResult,
  ExowattThreadSignalsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** Open signals one snapshot carries; past this the newest win. */
const MAX_OPEN_SIGNALS = 500;
/** Rows a list that includes acked signals returns, newest first then reordered. */
const MAX_LISTED_SIGNALS = 200;

const SignalRow = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  lane: ExowattThreadSignalLane,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  links: Schema.String,
  createdAt: Schema.String,
  ackedAt: Schema.NullOr(Schema.String),
});
type SignalRow = typeof SignalRow.Type;

const LinksJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeLinks = Schema.decodeUnknownOption(LinksJson);
const encodeLinks = Schema.encodeSync(LinksJson);

const parseLinks = (raw: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeLinks(raw), () => []);

const toSignal = (row: SignalRow): ExowattThreadSignal => ({
  id: row.id,
  threadId: row.threadId,
  lane: row.lane,
  title: row.title,
  detail: row.detail,
  links: parseLinks(row.links),
  createdAt: row.createdAt,
  ackedAt: row.ackedAt,
});

const storeError = (operation: string) => (cause: unknown) =>
  Effect.logWarning("Thread signal store query failed", { operation, cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new ExowattThreadSignalsError({ operation, reason: "the signal store could not be read" }),
      ),
    ),
  );

export interface EmitSignalInput {
  readonly threadId: ThreadId;
  readonly lane: ExowattThreadSignalLane;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly links?: ReadonlyArray<string> | undefined;
}

export interface ListSignalsInput {
  readonly threadId?: ThreadId | undefined;
  readonly lane?: ExowattThreadSignalLane | undefined;
  readonly includeAcked?: boolean | undefined;
}

export class ExowattThreadSignalStore extends Context.Service<
  ExowattThreadSignalStore,
  {
    readonly emit: (
      input: EmitSignalInput,
    ) => Effect.Effect<ExowattThreadSignal, ExowattThreadSignalsError>;
    readonly list: (
      input: ListSignalsInput,
    ) => Effect.Effect<ReadonlyArray<ExowattThreadSignal>, ExowattThreadSignalsError>;
    readonly ack: (
      input: ExowattThreadSignalsAckInput,
    ) => Effect.Effect<ExowattThreadSignalsAckResult, ExowattThreadSignalsError>;
  }
>()("t3/exowattThreadSignals/ExowattThreadSignalStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;

  const listOpenRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: SignalRow,
    execute: () => sql`
      SELECT * FROM (
        SELECT
          signal_id AS "id", thread_id AS "threadId", lane AS "lane", title AS "title",
          detail AS "detail", links AS "links", created_at AS "createdAt",
          acked_at AS "ackedAt",
          rowid AS "seq"
        FROM exowatt_thread_signals
        WHERE acked_at IS NULL AND lane <> 'ui'
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${MAX_OPEN_SIGNALS}
      ) ORDER BY "createdAt" ASC, "seq" ASC
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: SignalRow,
    execute: () => sql`
      SELECT * FROM (
        SELECT
          signal_id AS "id", thread_id AS "threadId", lane AS "lane", title AS "title",
          detail AS "detail", links AS "links", created_at AS "createdAt",
          acked_at AS "ackedAt",
          rowid AS "seq"
        FROM exowatt_thread_signals
        WHERE lane <> 'ui'
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${MAX_LISTED_SIGNALS}
      ) ORDER BY "createdAt" ASC, "seq" ASC
    `,
  });

  const emit: ExowattThreadSignalStore["Service"]["emit"] = Effect.fn(
    "ExowattThreadSignalStore.emit",
  )(
    function* (input) {
      const signal: ExowattThreadSignal = {
        id: yield* random.uuidV4(),
        threadId: input.threadId,
        lane: input.lane,
        title: input.title,
        detail: input.detail ?? null,
        links: input.links ?? [],
        createdAt: DateTime.formatIso(yield* DateTime.now),
        ackedAt: null,
      };
      yield* sql`
      INSERT INTO exowatt_thread_signals (
        signal_id, thread_id, lane, title, detail, links, created_at, acked_at
      ) VALUES (
        ${signal.id}, ${signal.threadId}, ${signal.lane}, ${signal.title},
        ${signal.detail}, ${encodeLinks(signal.links)}, ${signal.createdAt}, NULL
      )
    `;
      return signal;
    },
    Effect.catch(storeError("emit")),
  );

  const list: ExowattThreadSignalStore["Service"]["list"] = (input) =>
    (input.includeAcked === true ? listAllRows({}) : listOpenRows({})).pipe(
      Effect.map((rows) =>
        rows
          .map(toSignal)
          .filter(
            (signal) =>
              (input.threadId === undefined || signal.threadId === input.threadId) &&
              (input.lane === undefined || signal.lane === input.lane),
          ),
      ),
      Effect.catch(storeError("list")),
    );

  const ack: ExowattThreadSignalStore["Service"]["ack"] = Effect.fn("ExowattThreadSignalStore.ack")(
    function* (input) {
      const ids = input.ids ?? [];
      if (ids.length === 0 && input.threadId === undefined) return { acked: 0 };
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql<{ readonly id: string }>`
      UPDATE exowatt_thread_signals SET acked_at = ${now}
      WHERE acked_at IS NULL AND (
        thread_id = ${input.threadId ?? null}
        OR signal_id IN (SELECT value FROM json_each(${encodeLinks(ids)}))
      )
      RETURNING signal_id AS "id"
    `;
      return { acked: rows.length };
    },
    Effect.catch(storeError("ack")),
  );

  return ExowattThreadSignalStore.of({ emit, list, ack });
});

export const layer = Layer.effect(ExowattThreadSignalStore, make);
