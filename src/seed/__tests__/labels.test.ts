import { describe, expect, it } from "vitest";
import { buildSeedBundle } from "../data";
import { seedId } from "../ids";
import { SEED_ORDER_KEYS, seedOrderLabel, seedOrderLabels } from "../labels";

describe("seeded order labels", () => {
  const bundle = buildSeedBundle(new Date("2026-11-08T12:00:00.000Z"));

  it("cover exactly the seeded orders, one label each", () => {
    expect(bundle.orders.map((o) => o.id).sort()).toEqual(SEED_ORDER_KEYS.map((k) => seedId("order", k)).sort());
    expect(SEED_ORDER_KEYS).toHaveLength(10);
  });

  it("name the orders the Judge guide talks about", () => {
    expect(seedOrderLabel(seedId("order", "SEED-B"))).toBe("SEED-B");
    expect(seedOrderLabel(seedId("order", "SEED-F"))).toBe("SEED-F");
    expect(seedOrderLabel(seedId("order", "H3-ORD"))).toBe("H3-ORD");
    const amount = (key: string) => bundle.orders.find((o) => o.id === seedId("order", key))!.amountUsd;
    expect([amount("SEED-B"), amount("SEED-F")]).toEqual([210, 320]); // the amounts quoted in the Judge guide
  });

  it("give nothing to any other order", () => {
    expect(seedOrderLabel("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(seedOrderLabels([seedId("order", "SEED-A"), "not-a-seed", seedId("dispute", "SEED-C")])).toEqual({ [seedId("order", "SEED-A")]: "SEED-A" });
  });
});
