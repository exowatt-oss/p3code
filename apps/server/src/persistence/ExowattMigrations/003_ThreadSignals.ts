import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Green/yellow/red thread signals (`ExowattThreadSignalStore`). `links` is
  // a JSON array of strings; `ui` is a generated panel's JSON spec, set only
  // for lane `ui`. Open signals are the ones with no `acked_at`.
  yield* sql`
    CREATE TABLE IF NOT EXISTS exowatt_thread_signals (
      signal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      links TEXT NOT NULL,
      ui TEXT,
      created_at TEXT NOT NULL,
      acked_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_exowatt_thread_signals_open
    ON exowatt_thread_signals (acked_at, created_at)
  `;
});
