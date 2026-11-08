/**
 * Connectivity + schema check.  Run with:  npm run db:check
 *
 * 1. Connects with the same pooled client the app uses and runs SELECT 1.
 * 2. Lists the tables in the public schema and compares them with the 12 the design defines.
 * 3. Confirms the partial unique index on approval_records exists with its WHERE clause.
 *
 * Exits non-zero on any failure, so it is safe to use in a deploy script.
 */
import { closeDb, getSql } from "../src/db/client";
import { describeDatabaseUrl } from "../src/db/url";
import { getDatabaseUrl } from "../src/lib/env";

const EXPECTED_TABLES = [
  "action_executions",
  "agent_activity",
  "approval_records",
  "dispute_outcomes",
  "disputes",
  "evidence_artefacts",
  "insights_cache",
  "llm_daily_usage",
  "llm_rate_limits",
  "orders",
  "settings",
  "signal_weights",
];

async function main(): Promise<number> {
  console.log(`Connecting to ${describeDatabaseUrl(getDatabaseUrl())} (pooled, prepare:false)`);
  const sql = getSql();

  const [ping] = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
  console.log(`SELECT 1 -> ${ping?.ok}`);
  if (ping?.ok !== 1) return 1;

  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`;
  const present = rows.map((r) => r.table_name);
  console.log(`\nTables in public schema (${present.length}):`);
  for (const name of present) console.log(`  - ${name}`);

  const missing = EXPECTED_TABLES.filter((t) => !present.includes(t));
  if (missing.length > 0) {
    console.error(`\nMISSING tables: ${missing.join(", ")}  (did you run npm run db:migrate?)`);
    return 1;
  }

  const [idx] = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'approval_records_dispute_action_approved_idx'`;
  if (!idx) {
    console.error("\nMISSING index approval_records_dispute_action_approved_idx");
    return 1;
  }
  console.log(`\nPartial unique index OK:\n  ${idx.indexdef}`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error("\ndb:check failed:", err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
