import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { SEED_ACTIVITY_SESSION_ID, seedActivityIds } from "@/seed/activity";
import { seedId } from "@/seed/ids";
import { ACTIVITY_PAGE_SIZE, ActivityQuerySchema, toActivityEntry } from "../queries";

config({ path: ".env.local", quiet: true });

describe("ActivityQuerySchema", () => {
  it("defaults to page 1 of 20", () => {
    expect(ActivityQuerySchema.parse({})).toEqual({ page: 1, pageSize: ACTIVITY_PAGE_SIZE });
    expect(ACTIVITY_PAGE_SIZE).toBe(20);
  });

  it("coerces query-string numbers and accepts the filters", () => {
    const id = randomUUID();
    expect(ActivityQuerySchema.parse({ page: "3", pageSize: "10", refOrderId: id, stepType: "llm_call", status: "simulated" })).toEqual({
      page: 3, pageSize: 10, refOrderId: id, stepType: "llm_call", status: "simulated",
    });
  });

  it.each([
    ["page 0", { page: "0" }],
    ["a huge page size", { pageSize: "1000" }],
    ["a non-uuid order id", { refOrderId: "x'; DROP TABLE agent_activity;--" }],
    ["a non-uuid dispute id", { refDisputeId: "abc" }],
    ["an unknown step type", { stepType: "telepathy" }],
    ["an unknown status", { status: "maybe" }],
  ])("rejects %s", (_n, q) => {
    expect(ActivityQuerySchema.safeParse(q).success).toBe(false);
  });
});

describe("toActivityEntry", () => {
  it("flags seeded rows as demo data and drops the session id", () => {
    const row = { id: "a", createdAt: "t", stepType: "rule_engine", toolName: "x", inputSummary: "i", outputSummary: "o", durationMs: 1, status: "success", refOrderId: null, refDisputeId: null };
    expect(toActivityEntry({ ...row, sessionId: SEED_ACTIVITY_SESSION_ID } as never).isDemo).toBe(true);
    const own = toActivityEntry({ ...row, sessionId: "private-session" } as never);
    expect(own.isDemo).toBe(false);
    expect(JSON.stringify(own)).not.toContain("private-session");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("listActivity against the live database", () => {
  const mine = `activity-test-${randomUUID().slice(0, 8)}`;
  const theirs = `activity-test-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    const { closeDb, getSql } = await import("@/db/client");
    await getSql()`DELETE FROM agent_activity WHERE session_id IN (${mine}, ${theirs})`;
    await closeDb();
  });

  it("shows the session's own rows and the 8 seeded rows, never another session's, newest first", async () => {
    const { getSql } = await import("@/db/client");
    const { listActivity } = await import("../queries");
    const sql = getSql();
    const insert = (session: string, tool: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
      sql`INSERT INTO agent_activity ${sql({ id: randomUUID(), session_id: session, step_type: "rule_engine", tool_name: tool, input_summary: "i", output_summary: "o", duration_ms: 1, status: "success", created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ...extra })}`;
    await insert(mine, "mine_old", 10);
    await insert(mine, "mine_new", 1);
    await insert(theirs, "theirs", 0);

    const page = await listActivity(mine, { pageSize: 50 });
    const tools = page.entries.map((e) => e.toolName);
    expect(tools.slice(0, 2)).toEqual(["mine_new", "mine_old"]);
    expect(tools).not.toContain("theirs");
    const seeded = page.entries.filter((e) => e.isDemo);
    expect(seeded.map((e) => e.id).sort()).toEqual([...seedActivityIds()].sort());
    expect(page.entries.map((e) => e.createdAt)).toEqual([...page.entries.map((e) => e.createdAt)].sort().reverse());
  });

  it("filters by order, dispute, step type and status, and paginates", async () => {
    const { listActivity } = await import("../queries");
    const seedF = seedId("order", "SEED-F");
    const byOrder = await listActivity(mine, { refOrderId: seedF });
    expect(byOrder.entries.map((e) => e.toolName).sort()).toEqual(["risk_explanation", "score_order"]);

    const byDispute = await listActivity(mine, { refDisputeId: seedId("dispute", "SEED-E") });
    expect(byDispute.entries.map((e) => e.toolName).sort()).toEqual(["assess_dispute", "get_dispute"]);

    const simulated = await listActivity(mine, { status: "simulated" });
    expect(simulated.entries.every((e) => e.status === "simulated")).toBe(true);
    expect(simulated.entries.length).toBeGreaterThanOrEqual(1);
    expect((await listActivity(mine, { stepType: "llm_call" })).entries.every((e) => e.stepType === "llm_call")).toBe(true);

    const p1 = await listActivity(mine, { pageSize: 3, page: 1 });
    const p2 = await listActivity(mine, { pageSize: 3, page: 2 });
    expect(p1.entries).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    expect(p2.entries.map((e) => e.id).some((id) => p1.entries.map((e) => e.id).includes(id))).toBe(false);
    const last = await listActivity(mine, { pageSize: 50, page: 1 });
    expect(last.hasMore).toBe(false);
  });
});
