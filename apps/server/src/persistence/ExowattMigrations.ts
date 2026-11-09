// P3's numbered migrations, in their own `exowatt_sql_migrations` ledger after upstream's chain:
// a P3 id in `effect_sql_migrations` would take upstream's next number or, numbered high,
// suppress every later upstream migration (the migrator skips ids <= the highest recorded).
// Add `ExowattMigrations/NNN_Name.ts` plus an entry below; never edit a released one.
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Exowatt001 from "./ExowattMigrations/001_ThreadHubEntries.ts";
import Exowatt002 from "./ExowattMigrations/002_ThreadIcons.ts";
import Exowatt003 from "./ExowattMigrations/003_ThreadSignals.ts";

export const EXOWATT_MIGRATIONS_TABLE = "exowatt_sql_migrations";

const exowattMigrationEntries = [
  [1, "ThreadHubEntries", Exowatt001],
  [2, "ThreadIcons", Exowatt002],
  [3, "ThreadSignals", Exowatt003],
] as const;

const run = Migrator.make({});

export const runExowattMigrations = Effect.fn("runExowattMigrations")(function* () {
  const executed = yield* run({
    table: EXOWATT_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        exowattMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Exowatt migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
