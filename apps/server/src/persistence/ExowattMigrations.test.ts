import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { EXOWATT_MIGRATIONS_TABLE, runExowattMigrations } from "./ExowattMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
  });

const upstreamLatestId = Math.max(...migrationManifest.map(([id]) => id));

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("Exowatt migrations", (it) => {
  it.effect("runs after the upstream chain in their own ledger, leaving upstream's untouched", () =>
    Effect.gen(function* () {
      yield* runMigrations();

      const tables = yield* tableNames;
      assert.ok(tables.includes("exowatt_thread_hub_entries"));
      assert.ok(tables.includes("exowatt_thread_icons"));
      assert.ok(tables.includes("exowatt_thread_signals"));
      assert.ok(tables.includes(EXOWATT_MIGRATIONS_TABLE));

      assert.deepStrictEqual(
        (yield* ledger(EXOWATT_MIGRATIONS_TABLE)).map((row) => [row.migration_id, row.name]),
        [
          [1, "ThreadHubEntries"],
          [2, "ThreadIcons"],
          [3, "ThreadSignals"],
        ],
      );
      // Upstream's next migration id stays free.
      const upstream = yield* ledger("effect_sql_migrations");
      assert.strictEqual(Math.max(...upstream.map((row) => row.migration_id)), upstreamLatestId);
      assert.ok(upstream.every((row) => row.name !== "ThreadHubEntries"));

      // A second start has nothing left to run.
      assert.deepStrictEqual(yield* runExowattMigrations(), []);
    }),
  );
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "Exowatt migrations on a database P3 v1 numbered",
  (it) => {
    it.effect("still create the Hub table when id 53 was recorded for P3's old artifacts", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (53, 'ProjectionThreadArtifacts')
        `;
        yield* runMigrations();
        assert.ok((yield* tableNames).includes("exowatt_thread_hub_entries"));
      }),
    );
  },
);
