import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Hub overlay (`ExowattThreadHubStore`): one row per item the user pinned, hid or added.
  // `kind` + `item_key` are the client's item identity; a row with no flag and no manual
  // columns is deleted. The manual columns are set together (`manual_title` = hand-added).
  yield* sql`
    CREATE TABLE IF NOT EXISTS exowatt_thread_hub_entries (
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_key TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      manual_title TEXT,
      manual_url TEXT,
      manual_path TEXT,
      manual_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, kind, item_key)
    ) WITHOUT ROWID
  `;
});
