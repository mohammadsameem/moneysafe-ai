/**
 * Pure helpers for the Postgres connection string. No I/O, so they are unit-testable.
 */

/**
 * Query params that Prisma understands but postgres.js does not. postgres.js forwards unknown
 * URL params to the server as startup parameters, which a Postgres pooler can reject, so we
 * strip them rather than rely on the user's connection string being clean.
 */
const PRISMA_ONLY_PARAMS = ["pgbouncer", "connection_limit", "pool_timeout"] as const;

export function normalizeDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  for (const param of PRISMA_ONLY_PARAMS) url.searchParams.delete(param);
  return url.toString();
}

export function isLocalDatabaseUrl(raw: string): boolean {
  const { hostname } = new URL(raw);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** `host:port/database` with the user and password removed. Safe to print. */
export function describeDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}
