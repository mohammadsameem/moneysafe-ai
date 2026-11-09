/**
 * Runtime database client (Drizzle + postgres.js).
 *
 * Runtime always uses the POOLED DATABASE_URL (Supabase transaction pooler, port 6543), which
 * does not support prepared statements, hence `prepare: false`. Migrations use DIRECT_URL
 * (port 5432) through drizzle.config.ts and never go through this module.
 *
 * Lazy on purpose: importing this file never connects or throws, so `next build` works
 * without a database. The first getDb() call connects.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/env";
import * as schema from "./schema";
import { isLocalDatabaseUrl, normalizeDatabaseUrl } from "./url";

export type Db = PostgresJsDatabase<typeof schema>;

// Cache on globalThis so Next.js dev hot-reloads don't open a new pool on every edit.
const cache = globalThis as unknown as { __moneysafeSql?: postgres.Sql; __moneysafeDb?: Db };

function createSql(): postgres.Sql {
  const raw = getDatabaseUrl();
  return postgres(normalizeDatabaseUrl(raw), {
    prepare: false, // required by the Supabase transaction pooler
    // One query in flight per connection. postgres.js pipelines by default, and through the
    // Supavisor transaction pooler a pipelined query hangs (the server never receives its Sync and
    // holds the transaction open until statement_timeout), even on unrelated rows. Measured: 2
    // concurrent queries on one connection hang; with max_pipeline: 1 a query waits for a free
    // connection instead and 20 concurrent same-row updates finish in under a second.
    max_pipeline: 1,
    ssl: isLocalDatabaseUrl(raw) ? false : "require",
    max: process.env.VERCEL ? 1 : 5, // one connection per serverless instance
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

/** The raw postgres.js client, for `SELECT 1` health checks and ad-hoc SQL. */
export function getSql(): postgres.Sql {
  cache.__moneysafeSql ??= createSql();
  return cache.__moneysafeSql;
}

/** The typed Drizzle client. */
export function getDb(): Db {
  cache.__moneysafeDb ??= drizzle(getSql(), { schema });
  return cache.__moneysafeDb;
}

/** Close the pool. Scripts call this so the process can exit. */
export async function closeDb(): Promise<void> {
  const sql = cache.__moneysafeSql;
  cache.__moneysafeSql = undefined;
  cache.__moneysafeDb = undefined;
  if (sql) await sql.end({ timeout: 5 });
}
