import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runExowattMigrations } from "./ExowattMigrations.ts";
import MigrationPullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";

// Idempotent P3 schema repairs after upstream's chain, by presence check, never a numbered
// migration in upstream's ledger. New P3 tables go in `ExowattMigrations.ts`, run from here.
const tableExists = Effect.fn("ExowattSchemaPatches.tableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `;
  return rows.length > 0;
});

// P3 once recorded id 53 for its old artifacts migration, so upstream's 53
// (`PullRequestFilesViewed`) never runs there. Once 53 is recorded, apply upstream's
// `IF NOT EXISTS` DDL when the table is missing; before that, leave it to the migrator.
const ensurePullRequestFilesViewed = Effect.gen(function* () {
  if (yield* tableExists("pull_request_files_viewed")) {
    return false;
  }
  if (!(yield* tableExists("effect_sql_migrations"))) {
    return false;
  }
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{ readonly migrationId: number }>`
    SELECT migration_id AS "migrationId" FROM effect_sql_migrations WHERE migration_id = 53
  `;
  if (recorded.length === 0) {
    return false;
  }
  yield* MigrationPullRequestFilesViewed;
  return true;
});

export const applyExowattSchemaPatches = Effect.fn("applyExowattSchemaPatches")(function* () {
  const added: Array<string> = [];
  if (yield* ensurePullRequestFilesViewed) {
    added.push("pull_request_files_viewed");
  }
  if (added.length > 0) {
    yield* Effect.log("Exowatt schema patches applied").pipe(
      Effect.annotateLogs({ patches: added }),
    );
  }
  yield* runExowattMigrations();
  return added as ReadonlyArray<string>;
});
