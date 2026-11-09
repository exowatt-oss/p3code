import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A Font Awesome icon per thread (`ExowattThreadIconStore`). `title` is the
  // thread title the icon was picked for, so a rename picks again; `source`
  // says whether a model chose it or the keyword fallback did.
  yield* sql`
    CREATE TABLE IF NOT EXISTS exowatt_thread_icons (
      thread_id TEXT PRIMARY KEY,
      icon TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
