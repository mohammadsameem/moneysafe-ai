import { describe, expect, it } from "vitest";
import { toActivityRow } from "@/lib/activity/logger";
import { SEED_ACTIVITY_PREFIX, SEED_ACTIVITY_SESSION_ID, buildSeedActivity, isSeedActivity, seedActivityIds } from "../activity";
import { buildSeedBundle } from "../data";
import { seedId } from "../ids";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const rows = buildSeedActivity(NOW);
const bundle = buildSeedBundle(NOW);

describe("seeded agent activity", () => {
  it("has 8 rows mixing rule_engine, llm_call and paypal_api, exactly one of them simulated", () => {
    expect(rows).toHaveLength(8);
    const kinds = new Set(rows.map((r) => r.stepType));
    expect(Array.from(kinds).sort()).toEqual(["llm_call", "paypal_api", "rule_engine"]);
    expect(rows.filter((r) => r.status === "simulated")).toHaveLength(1);
    expect(rows.find((r) => r.status === "simulated")?.stepType).toBe("paypal_api");
  });

  it("uses deterministic seed ids, unique and stable across runs (so the runner upserts and Reset can restore them)", () => {
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildSeedActivity(new Date("2030-01-01T00:00:00Z")).map((r) => r.id)).toEqual(ids);
    expect(seedActivityIds()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is clearly demo data: the marker session id and a 'Demo data:' prefix on every row", () => {
    for (const r of rows) {
      expect(r.sessionId).toBe(SEED_ACTIVITY_SESSION_ID);
      expect(r.outputSummary?.startsWith(SEED_ACTIVITY_PREFIX)).toBe(true);
      expect(isSeedActivity({ sessionId: r.sessionId ?? null })).toBe(true);
    }
    expect(isSeedActivity({ sessionId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" })).toBe(false); // a real session id
    expect(isSeedActivity({ sessionId: null })).toBe(false);
  });

  it("only references seeded orders and disputes that exist in the seed bundle", () => {
    const orderIds = new Set(bundle.orders.map((o) => o.id));
    const disputeIds = new Set(bundle.disputes.map((d) => d.id));
    for (const r of rows) {
      expect(r.refOrderId ?? r.refDisputeId, r.toolName).toBeTruthy();
      if (r.refOrderId) expect(orderIds.has(r.refOrderId), r.toolName).toBe(true);
      if (r.refDisputeId) expect(disputeIds.has(r.refDisputeId), r.toolName).toBe(true);
    }
  });

  it("tells the same story as the seeded numbers", () => {
    const text = (key: string) => rows.find((r) => r.id === seedId("activity", key))!.outputSummary!;
    expect(text("SEED-B-score")).toContain("score 55 -> verify");
    expect(text("SEED-F-score")).toContain("score 70 -> hold");
    expect(text("SEED-C-assess")).toContain("system recommends contest");
    expect(text("SEED-E-assess")).toContain("completeness 75%; base 44%");
    const seedB = bundle.orders.find((o) => o.id === seedId("order", "SEED-B"))!;
    const seedF = bundle.orders.find((o) => o.id === seedId("order", "SEED-F"))!;
    expect(seedB.riskScore).toBe(55);
    expect(seedF.riskScore).toBe(70);
  });

  it("is ordered oldest first and never dated in the future", () => {
    const times = rows.map((r) => r.createdAt!);
    expect(times).toEqual([...times].sort());
    for (const t of times) expect(new Date(t).getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it("would pass through the real logger unchanged: no email, already short, nothing to scrub", () => {
    for (const r of rows) {
      const through = toActivityRow({
        sessionId: r.sessionId,
        refOrderId: r.refOrderId,
        refDisputeId: r.refDisputeId,
        stepType: r.stepType!,
        toolName: r.toolName!,
        inputSummary: r.inputSummary!,
        outputSummary: r.outputSummary!,
        durationMs: r.durationMs!,
        status: r.status!,
      });
      expect(through.inputSummary).toBe(r.inputSummary);
      expect(through.outputSummary).toBe(r.outputSummary);
      expect(`${r.inputSummary} ${r.outputSummary}`).not.toMatch(/@/);
    }
  });
});
