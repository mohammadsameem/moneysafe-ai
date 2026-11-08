import { config } from "dotenv";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "../schema";
import { describeDatabaseUrl, isLocalDatabaseUrl, normalizeDatabaseUrl } from "../url";

config({ path: ".env.local", quiet: true });

describe("database URL helpers", () => {
  it("strips Prisma-only params but keeps everything else", () => {
    const out = normalizeDatabaseUrl(
      "postgresql://u:p@host.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require",
    );
    expect(out).not.toContain("pgbouncer");
    expect(out).not.toContain("connection_limit");
    expect(out).toContain("sslmode=require");
    expect(out).toContain(":6543/postgres");
  });

  it("detects local hosts", () => {
    expect(isLocalDatabaseUrl("postgres://u:p@localhost:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@127.0.0.1:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@db.abc.supabase.co:5432/postgres")).toBe(false);
  });

  it("describes a URL without leaking credentials", () => {
    const text = describeDatabaseUrl("postgresql://postgres.ref:s3cret@aws-0.pooler.supabase.com:6543/postgres");
    expect(text).toBe("aws-0.pooler.supabase.com:6543/postgres");
    expect(text).not.toContain("s3cret");
  });
});

describe("schema shape (design.md section 3)", () => {
  const tables = [
    schema.orders,
    schema.settings,
    schema.evidenceArtefacts,
    schema.disputes,
    schema.approvalRecords,
    schema.actionExecutions,
    schema.agentActivity,
    schema.signalWeights,
    schema.disputeOutcomes,
    schema.llmRateLimits,
    schema.llmDailyUsage,
    schema.insightsCache,
  ];

  it("defines exactly the 12 tables from the design", () => {
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([
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
    ]);
  });

  it("enforces one APPROVED record per (dispute, action) with a partial unique index", () => {
    const { indexes } = getTableConfig(schema.approvalRecords);
    const idx = indexes.find((i) => i.config.name === "approval_records_dispute_action_approved_idx");
    expect(idx, "partial unique index is defined").toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where, "index has a WHERE clause").toBeDefined();
    expect(idx?.config.columns.map((c) => ("name" in c ? c.name : ""))).toEqual(["dispute_id", "action_type"]);
  });

  it("links one execution to one approval and one outcome to one dispute", () => {
    // Column-level .unique() is recorded on the column (isUnique), not in uniqueConstraints.
    const isUnique = (table: Parameters<typeof getTableConfig>[0], column: string) =>
      getTableConfig(table).columns.find((c) => c.name === column)?.isUnique === true;
    expect(isUnique(schema.actionExecutions, "approval_record_id")).toBe(true);
    expect(isUnique(schema.disputeOutcomes, "dispute_id")).toBe(true);
    expect(isUnique(schema.orders, "paypal_order_id")).toBe(true);
    expect(isUnique(schema.disputes, "paypal_dispute_id")).toBe(true);
  });
});

// Live connectivity test: runs only when a database is configured (e.g. in .env.local).
describe.skipIf(!process.env.DATABASE_URL)("live database", () => {
  afterAll(async () => {
    const { closeDb } = await import("../client");
    await closeDb();
  });

  it("answers SELECT 1 through the pooled client", async () => {
    const { getSql } = await import("../client");
    const [row] = await getSql()<{ ok: number }[]>`SELECT 1 AS ok`;
    expect(row?.ok).toBe(1);
  });
});
