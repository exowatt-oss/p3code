import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { applyExowattSchemaPatches } from "./ExowattSchemaPatches.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "ExowattSchemaPatches on an upstream-numbered database",
  (it) => {
    it.effect("adds nothing after the upstream migration chain, idempotently", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        assert.deepStrictEqual(yield* applyExowattSchemaPatches(), []);
      }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "ExowattSchemaPatches on a P3-numbered database",
  (it) => {
    it.effect(
      "applies upstream PullRequestFilesViewed when id 53 was recorded for P3's ProjectionThreadArtifacts",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          // A database written by an older P3 build: upstream chain through 52, then
          // P3's own migration 53 recorded under its name.
          yield* runMigrations({ toMigrationInclusive: 52 });
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (53, 'ProjectionThreadArtifacts')
          `;

          // The chain resumes right after P3's 53 and runs every later upstream id.
          const executed = yield* runMigrations().pipe(
            Effect.map((rows) => rows.map(([id]) => id)),
          );
          assert.strictEqual(executed[0], 54);
          assert.deepStrictEqual(
            executed,
            executed.map((_, index) => 54 + index),
          );

          const tables = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'pull_request_files_viewed'
          `;
          assert.strictEqual(tables.length, 1);
          assert.deepStrictEqual(yield* applyExowattSchemaPatches(), []);
        }),
    );
  },
);
