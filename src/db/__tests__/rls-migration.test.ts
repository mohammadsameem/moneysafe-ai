/**
 * The RLS migration (0001_enable_rls.sql), checked as text so it needs no database: every app table gets RLS and no
 * policy, the public roles lose their privileges, and nothing in it is destructive or repeat-unsafe.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../schema";

const dir = join(__dirname, "..", "migrations");
const sql = readFileSync(join(dir, "0001_enable_rls.sql"), "utf8");
const init = readFileSync(join(dir, "0000_init.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };

const appTables = [
  schema.orders,
  schema.settings,
  schema.evidenceArtefacts,
  schema.disputes,
  schema.approvalRecords,
  schema.actionExecutions,
  schema.disputeOutcomes,
  schema.signalWeights,
  schema.agentActivity,
  schema.insightsCache,
  schema.llmRateLimits,
  schema.llmDailyUsage,
]
  .map((t) => getTableConfig(t).name)
  .sort();

/** All first capture groups of a global regex, as a plain array. */
function allMatches(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(pattern.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1] as string);
  return out;
}

const code = sql.replace(/--.*$/gm, ""); // the header comment mentions FORCE and policies on purpose

describe("0001_enable_rls.sql", () => {
  it("covers exactly the 12 app tables", () => {
    expect(appTables).toHaveLength(12);
    expect(allMatches(code, /ALTER TABLE "([a-z_]+)" ENABLE ROW LEVEL SECURITY;/).sort()).toEqual(appTables);
    expect(allMatches(init, /CREATE TABLE "([a-z_]+)"/).sort()).toEqual(appTables);
  });

  it("revokes from both public roles on the same 12 tables, and only if the roles exist", () => {
    const listed = allMatches(code, /'([a-z_]+)'/).filter((n) => appTables.indexOf(n) >= 0);
    expect(listed.sort()).toEqual(appTables);
    expect(code).toContain("ARRAY['anon', 'authenticated']");
    expect(code).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)");
    expect(code).toContain("REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I");
  });

  it("creates no policy and does not FORCE row level security (the owner role the app uses must keep working)", () => {
    expect(code).not.toMatch(/CREATE\s+POLICY/i);
    expect(code).not.toMatch(/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  });

  it("is safe to run twice: no CREATE, DROP, DELETE, TRUNCATE or data change", () => {
    expect(code).not.toMatch(/\b(CREATE|DROP|DELETE|TRUNCATE|INSERT|UPDATE)\b/i);
  });

  it("is registered after the init migration", () => {
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_init", "0001_enable_rls"]);
  });
});
