import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_WEIGHTS, SIGNAL_NAMES, type SignalWeightValues } from "@/lib/scoring";
import { MAX_WEIGHT_DELTA, WEIGHT_MAX, WEIGHT_MIN, capProposal, hasWeightChange, proposedWeights, weightChanges } from "../weights";
import { makeWeightsRow, withProposal } from "./fakes";

const base = (over: Partial<SignalWeightValues> = {}): SignalWeightValues => ({ ...DEFAULT_SIGNAL_WEIGHTS, ...over });

describe("capProposal: +/-3 per cycle, and always within [5, 30]", () => {
  it("passes a small change through untouched", () => {
    const out = capProposal(base(), base({ first_time_high_value: 23, rush_shipping: 13 }));
    expect(out.weights).toEqual(base({ first_time_high_value: 23, rush_shipping: 13 }));
    expect(out.capped).toBe(false);
  });

  it("limits a larger jump to 3 points, up or down", () => {
    const out = capProposal(base(), base({ country_mismatch: 30, disposable_email: 1, repeated_attempts: 14 }));
    expect(out.weights.country_mismatch).toBe(23);
    expect(out.weights.disposable_email).toBe(12);
    expect(out.weights.repeated_attempts).toBe(13);
    expect(out.capped).toBe(true);
  });

  it("keeps a weight at 30 or 5 even when a delta would pass the bound", () => {
    expect(capProposal(base({ rush_shipping: 29 }), base({ rush_shipping: 40 })).weights.rush_shipping).toBe(30);
    expect(capProposal(base({ rush_shipping: 30 }), base({ rush_shipping: 40 })).weights.rush_shipping).toBe(30);
    expect(capProposal(base({ rush_shipping: 6 }), base({ rush_shipping: 1 })).weights.rush_shipping).toBe(5);
    expect(capProposal(base({ rush_shipping: 5 }), base({ rush_shipping: 1 })).weights.rush_shipping).toBe(5);
  });

  it("holds for every signal and for the extremes of the schema range (1 and 40)", () => {
    for (const current of [5, 6, 12, 28, 30]) {
      for (const target of [1, 5, 17, 30, 40]) {
        const out = capProposal(base({ ...Object.fromEntries(SIGNAL_NAMES.map((s) => [s, current])) }), base({ ...Object.fromEntries(SIGNAL_NAMES.map((s) => [s, target])) }));
        for (const s of SIGNAL_NAMES) {
          expect(Math.abs(out.weights[s] - current)).toBeLessThanOrEqual(MAX_WEIGHT_DELTA);
          expect(out.weights[s]).toBeGreaterThanOrEqual(WEIGHT_MIN);
          expect(out.weights[s]).toBeLessThanOrEqual(WEIGHT_MAX);
        }
      }
    }
  });

  it("rounds a fractional proposal and never mutates its inputs", () => {
    const current = base();
    const proposed = base({ country_mismatch: 21.6 });
    const out = capProposal(current, proposed);
    expect(out.weights.country_mismatch).toBe(22);
    expect(current).toEqual(DEFAULT_SIGNAL_WEIGHTS);
    expect(proposed.country_mismatch).toBe(21.6);
  });
});

describe("weightChanges / proposedWeights", () => {
  it("lists only the signals that differ, in the fixed signal order", () => {
    const changes = weightChanges(base(), base({ rush_shipping: 12, country_mismatch: 23 }));
    expect(changes).toEqual([
      { signal: "country_mismatch", from: 20, to: 23, delta: 3 },
      { signal: "rush_shipping", from: 15, to: 12, delta: -3 },
    ]);
    expect(hasWeightChange(base(), base())).toBe(false);
  });

  it("reads the pending proposal off the row, and is null without one", () => {
    expect(proposedWeights(makeWeightsRow())).toBeNull();
    const row = makeWeightsRow(withProposal(base({ first_time_high_value: 23 })));
    expect(proposedWeights(row)).toEqual(base({ first_time_high_value: 23 }));
    // A half-written proposal is not a proposal.
    expect(proposedWeights(makeWeightsRow({ ...withProposal(base()), proposedRushShipping: null }))).toBeNull();
  });
});
