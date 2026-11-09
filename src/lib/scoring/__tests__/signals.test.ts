import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNAL_WEIGHTS,
  SIGNAL_NAMES,
  computeRiskScore,
  evaluateSignals,
  toVerdict,
  type ScoringOrder,
  type SignalName,
  type SignalWeightValues,
} from "../signals";
import { BASELINE_USD, cleanOrder } from "./fixtures";

/** Names of the signals that fire for an order. */
function fired(order: ScoringOrder, weights: SignalWeightValues = DEFAULT_SIGNAL_WEIGHTS, baseline = BASELINE_USD) {
  return evaluateSignals(order, weights, baseline)
    .filter((s) => s.active)
    .map((s) => s.signal);
}

const scoreOf = (order: ScoringOrder, weights: SignalWeightValues = DEFAULT_SIGNAL_WEIGHTS) =>
  computeRiskScore(evaluateSignals(order, weights, BASELINE_USD));

describe("each signal in isolation: only the targeted signal fires", () => {
  it("country_mismatch: billing country differs from shipping country", () => {
    expect(fired(cleanOrder({ shippingCountry: "GB" }))).toEqual(["country_mismatch"]);
    expect(fired(cleanOrder({ billingCountry: "us" }))).toEqual([]); // case alone is not a mismatch
  });

  it("first_time_high_value: first-time buyer AND amount strictly over $200", () => {
    expect(fired(cleanOrder({ buyerIsFirstTime: true, amountUsd: 210 }))).toEqual(["first_time_high_value"]);
    expect(fired(cleanOrder({ buyerIsFirstTime: true, amountUsd: 200 }))).toEqual([]); // not strictly over
    expect(fired(cleanOrder({ buyerIsFirstTime: false, amountUsd: 210 }))).toEqual([]); // returning buyer
  });

  it("rush_shipping: overnight or rush, but not express", () => {
    expect(fired(cleanOrder({ shippingMethod: "rush" }))).toEqual(["rush_shipping"]);
    expect(fired(cleanOrder({ shippingMethod: "overnight" }))).toEqual(["rush_shipping"]);
    expect(fired(cleanOrder({ shippingMethod: "express" }))).toEqual([]);
  });

  it("high_relative_value: amount strictly over 3x the baseline average", () => {
    expect(fired(cleanOrder({ amountUsd: 300 }))).toEqual(["high_relative_value"]); // 300 > 3 x 85
    expect(fired(cleanOrder({ amountUsd: 255 }))).toEqual([]); // exactly 3 x 85
    expect(fired(cleanOrder({ amountUsd: 300 }), DEFAULT_SIGNAL_WEIGHTS, 100)).toEqual([]); // baseline is a parameter
  });

  it("disposable_email: known throwaway-mail domain, including subdomains", () => {
    expect(fired(cleanOrder({ buyerEmail: "x@mailinator.com" }))).toEqual(["disposable_email"]);
    expect(fired(cleanOrder({ buyerEmail: "X@MAILINATOR.COM" }))).toEqual(["disposable_email"]);
    expect(fired(cleanOrder({ buyerEmail: "x@inbox.mailinator.com" }))).toEqual(["disposable_email"]);
    expect(fired(cleanOrder({ buyerEmail: "x@example.com" }))).toEqual([]);
  });

  it("repeated_attempts: three or more payment attempts", () => {
    expect(fired(cleanOrder({ paymentAttemptCount: 3 }))).toEqual(["repeated_attempts"]);
    expect(fired(cleanOrder({ paymentAttemptCount: 2 }))).toEqual([]);
  });
});

describe("all six signals active", () => {
  const everything = cleanOrder({
    buyerIsFirstTime: true,
    amountUsd: 400,
    shippingMethod: "rush",
    shippingCountry: "GB",
    buyerEmail: "x@mailinator.com",
    paymentAttemptCount: 3,
  });

  it("scores 100, and the clamp holds when the weights would add up to more", () => {
    expect(fired(everything).sort()).toEqual([...SIGNAL_NAMES].sort());
    expect(scoreOf(everything)).toBe(100); // 20+20+15+20+15+10

    const heavy = Object.fromEntries(SIGNAL_NAMES.map((n) => [n, 30])) as Record<SignalName, number>;
    expect(scoreOf(everything, heavy)).toBe(100); // raw 180, clamped
  });
});

describe("verdict boundaries", () => {
  it("39 ship, 40 verify, 69 verify, 70 hold", () => {
    expect(toVerdict(39)).toBe("ship");
    expect(toVerdict(40)).toBe("verify");
    expect(toVerdict(69)).toBe("verify");
    expect(toVerdict(70)).toBe("hold");
  });
});

describe("seed order scores (baseline $85)", () => {
  const cases: { name: string; order: ScoringOrder; score: number; verdict: "ship" | "verify" | "hold" }[] = [
    { name: "SEED-A", order: cleanOrder({ amountUsd: 145 }), score: 0, verdict: "ship" },
    {
      name: "SEED-B",
      order: cleanOrder({ amountUsd: 210, buyerIsFirstTime: true, shippingMethod: "rush", shippingCountry: "GB" }),
      score: 55,
      verdict: "verify",
    },
    { name: "SEED-D-ORD", order: cleanOrder({ amountUsd: 38 }), score: 0, verdict: "ship" },
    {
      name: "SEED-E-ORD",
      order: cleanOrder({ amountUsd: 210, buyerIsFirstTime: true, shippingCountry: "CA" }),
      score: 40,
      verdict: "verify",
    },
    {
      name: "SEED-F",
      order: cleanOrder({
        amountUsd: 320,
        shippingMethod: "rush",
        shippingCountry: "DE",
        buyerEmail: "tmp.buyer@mailinator.com",
      }),
      score: 70,
      verdict: "hold",
    },
  ];

  it.each(cases)("$name scores $score and is '$verdict'", ({ order, score, verdict }) => {
    const result = scoreOf(order);
    expect(result).toBe(score);
    expect(toVerdict(result)).toBe(verdict);
  });
});

describe("learning-loop weight change", () => {
  it("lowering country_mismatch to 5 moves SEED-B from 55 to 40, still 'verify'", () => {
    const seedB = cleanOrder({ amountUsd: 210, buyerIsFirstTime: true, shippingMethod: "rush", shippingCountry: "GB" });
    expect(scoreOf(seedB)).toBe(55);

    const adjusted = { ...DEFAULT_SIGNAL_WEIGHTS, country_mismatch: 5 };
    const newScore = scoreOf(seedB, adjusted);
    expect(newScore).toBe(40); // 5 + 20 + 15
    expect(toVerdict(newScore)).toBe("verify");
  });
});
