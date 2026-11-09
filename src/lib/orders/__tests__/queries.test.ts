import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { isUuid, toOrderDetail, toOrderSummary } from "../queries";
import { makeOrder } from "./fakes";

config({ path: ".env.local", quiet: true });

describe("toOrderSummary / toOrderDetail", () => {
  const scored = makeOrder({
    id: "o-1",
    riskScore: 55,
    verdict: "verify",
    usedFallback: true,
    aiExplanation: "Because.",
    verificationDraft: { subject: "S", body: "B" },
    evidenceCompleteness: 60,
    signalBreakdown: [{ signal: "rush_shipping", active: true, weight: 15 }],
    sessionId: "private-session-id",
    paypalOrderId: "PAYPAL-SECRET-ID",
    paypalCaptureId: "CAPTURE-SECRET-ID",
  });

  it("summary has what the list needs, including riskScore, verdict and isDemo", () => {
    expect(toOrderSummary(scored)).toEqual({
      id: "o-1",
      buyerEmail: scored.buyerEmail,
      amountUsd: scored.amountUsd,
      currency: "USD",
      status: "created",
      riskScore: 55,
      verdict: "verify",
      isDemo: false,
      usedFallback: true,
      createdAt: scored.createdAt,
    });
  });

  it("flags both seeded and demo orders as demo data", () => {
    expect(toOrderSummary(makeOrder({ isSeed: true })).isDemo).toBe(true);
    expect(toOrderSummary(makeOrder({ isDemo: true })).isDemo).toBe(true);
    expect(toOrderSummary(makeOrder({})).isDemo).toBe(false);
  });

  it("detail adds the breakdown, explanation, draft and usedFallback", () => {
    const d = toOrderDetail(scored);
    expect(d).toMatchObject({
      aiExplanation: "Because.",
      usedFallback: true,
      verificationDraft: { subject: "S", body: "B" },
      evidenceCompleteness: 60,
      signalBreakdown: [{ signal: "rush_shipping", active: true, weight: 15 }],
      shippingMethod: "standard",
      buyerIsFirstTime: true,
    });
  });

  it("returns an empty breakdown, not null, for an unscored order", () => {
    expect(toOrderDetail(makeOrder({ signalBreakdown: null })).signalBreakdown).toEqual([]);
  });

  it("never exposes session ids or PayPal ids", () => {
    const text = JSON.stringify([toOrderSummary(scored), toOrderDetail(scored)]);
    for (const secret of ["private-session-id", "PAYPAL-SECRET-ID", "CAPTURE-SECRET-ID"]) expect(text).not.toContain(secret);
  });
});

describe("isUuid", () => {
  it("accepts UUIDs and rejects everything else", () => {
    expect(isUuid("22222222-2222-4222-8222-222222222222")).toBe(true);
    for (const bad of ["", "abc", "22222222-2222-4222-8222-22222222222", "22222222-2222-4222-8222-2222222222222", "x'; DROP TABLE orders;--", "../etc"]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("read repo against the live database (visibility)", () => {
  const mine = `qry-test-${randomUUID().slice(0, 8)}-mine`;
  const theirs = `qry-test-${randomUUID().slice(0, 8)}-theirs`;
  const mineId = randomUUID();
  const theirsId = randomUUID();

  afterAll(async () => {
    const { closeDb, getSql } = await import("@/db/client");
    await getSql()`DELETE FROM orders WHERE id = ANY(${[mineId, theirsId]}::uuid[])`;
    await closeDb();
  });

  it("shows the seeded orders plus only the caller's own", async () => {
    const { getDb } = await import("@/db/client");
    const { orders } = await import("@/db/schema");
    const { createDrizzleReadRepo } = await import("../queries");
    const base = { buyerEmail: "q@example.com", buyerIsFirstTime: true, shippingMethod: "standard", billingCountry: "US", shippingCountry: "US", amountUsd: 10, status: "captured", isSeed: false, isDemo: true } as const;
    await getDb().insert(orders).values([
      { ...base, id: mineId, sessionId: mine },
      { ...base, id: theirsId, sessionId: theirs },
    ]);

    const repo = createDrizzleReadRepo();
    const list = await repo.listVisible(mine);
    const ids = list.map((o) => o.id);

    expect(ids).toContain(mineId);
    expect(ids).not.toContain(theirsId);
    expect(list.filter((o) => o.isSeed)).toHaveLength(10);
    expect(list.every((o) => o.isSeed || o.sessionId === mine)).toBe(true);
    // newest first
    expect(list.map((o) => o.createdAt)).toEqual([...list.map((o) => o.createdAt)].sort().reverse());

    expect((await repo.findVisible(mineId, mine))?.id).toBe(mineId);
    expect(await repo.findVisible(theirsId, mine)).toBeNull(); // someone else's order looks like it does not exist
    expect(await repo.findVisible("not-a-uuid", mine)).toBeNull(); // no database error for a malformed id
    expect(await repo.findVisible(randomUUID(), mine)).toBeNull();
    const seed = list.find((o) => o.isSeed);
    expect((await repo.findVisible(seed!.id, mine))?.id).toBe(seed!.id);
  });
});
