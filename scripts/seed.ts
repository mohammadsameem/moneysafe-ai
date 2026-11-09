/**
 * CLI entry for seeding.  Run with:  npm run db:seed
 * Safe to run repeatedly: rows are upserted by deterministic ID, never duplicated.
 */
import { closeDb, getDb } from "../src/db/client";
import { runSeed } from "../src/seed/runner";

runSeed(getDb())
  .then(async ({ upserted }) => {
    console.log("Seed complete. Rows upserted this run:");
    for (const [table, n] of Object.entries(upserted)) console.log(`  ${table.padEnd(20)} ${n}`);
    await closeDb();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
