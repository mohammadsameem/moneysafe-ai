import { describe, expect, it } from "vitest";
import { demoCopyId, SHARED_EXAMPLE_KEYS } from "@/lib/demo/ids";
import { buildSeedBundle } from "@/seed/data";
import { seedId } from "@/seed/ids";
import { SEED_DISPUTE_KEYS, seedDisputeLabel, seedDisputeLabels } from "../seed-labels";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("seeded dispute labels", () => {
  const bundle = buildSeedBundle(new Date("2026-11-08T12:00:00.000Z"));

  it("cover exactly the seeded disputes, one label each", () => {
    expect(bundle.disputes.map((d) => d.id).sort()).toEqual(SEED_DISPUTE_KEYS.map((k) => seedId("dispute", k)).sort());
    for (const key of SEED_DISPUTE_KEYS) expect(seedDisputeLabel(seedId("dispute", key), SESSION)).toBe(key);
  });

  it("label a session's own Start-demo copy of each open example, and only that session's", () => {
    for (const key of SHARED_EXAMPLE_KEYS) {
      const copy = demoCopyId(SESSION, seedId("dispute", key));
      expect(seedDisputeLabel(copy, SESSION)).toBe(`Your copy of ${key}`);
      expect(seedDisputeLabel(copy, OTHER)).toBeNull();
    }
  });

  it("give nothing to a real dispute or a seeded order", () => {
    expect(seedDisputeLabel("dcc4b084-0000-4000-8000-000000000000", SESSION)).toBeNull();
    expect(seedDisputeLabels([seedId("dispute", "SEED-D"), "not-a-seed", seedId("order", "SEED-A")], SESSION)).toEqual({ [seedId("dispute", "SEED-D")]: "SEED-D" });
  });

  it("match what the Judge guide says about SEED-C: item not received, $145", () => {
    const c = bundle.disputes.find((d) => d.id === seedId("dispute", "SEED-C"))!;
    expect([c.reason, c.disputedAmountUsd]).toEqual(["item_not_received", 145]);
  });
});
