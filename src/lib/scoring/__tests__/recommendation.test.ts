import { describe, expect, it } from "vitest";
import { computeSystemRecommendation, contestExpectedValue, resolveFinalRecommendation } from "../recommendation";

const FEE = 20;
const EFFORT = 10;

describe("contest-vs-refund expected-value rule (fee $20, effort $10)", () => {
  it("$145 at p=0.90 -> contest (EV 118.5)", () => {
    expect(contestExpectedValue(145, 0.9, FEE, EFFORT)).toBeCloseTo(118.5, 10);
    expect(computeSystemRecommendation(145, 0.9, FEE, EFFORT)).toBe("contest");
  });

  it("$38 at p=0.40 -> refund (EV -6.8)", () => {
    expect(contestExpectedValue(38, 0.4, FEE, EFFORT)).toBeCloseTo(-6.8, 10);
    expect(computeSystemRecommendation(38, 0.4, FEE, EFFORT)).toBe("refund");
  });

  it("$60 at p=0.30 -> refund (EV -6.0)", () => {
    expect(contestExpectedValue(60, 0.3, FEE, EFFORT)).toBeCloseTo(-6.0, 10);
    expect(computeSystemRecommendation(60, 0.3, FEE, EFFORT)).toBe("refund");
  });

  it("EV of exactly 0 -> refund (contest needs a strictly positive EV)", () => {
    // 0.5 * 50 - 0.5 * 20 - 15 = 25 - 10 - 15 = 0, exact in floating point
    expect(contestExpectedValue(50, 0.5, FEE, 15)).toBe(0);
    expect(computeSystemRecommendation(50, 0.5, FEE, 15)).toBe("refund");
  });
});

describe("resolveFinalRecommendation (the model may override, the source says so)", () => {
  it("no override -> the system recommendation, source 'system'", () => {
    expect(resolveFinalRecommendation("contest", null)).toEqual({ recommendation: "contest", source: "system", override: null });
    expect(resolveFinalRecommendation("refund", undefined)).toEqual({ recommendation: "refund", source: "system", override: null });
  });

  it("an override that differs is used and labelled 'ai_adjusted'", () => {
    expect(resolveFinalRecommendation("contest", "refund")).toEqual({ recommendation: "refund", source: "ai_adjusted", override: "refund" });
    expect(resolveFinalRecommendation("refund", "contest")).toEqual({ recommendation: "contest", source: "ai_adjusted", override: "contest" });
  });

  it("an override that agrees with the system is not an override", () => {
    expect(resolveFinalRecommendation("contest", "contest")).toEqual({ recommendation: "contest", source: "system", override: null });
    expect(resolveFinalRecommendation("refund", "refund")).toEqual({ recommendation: "refund", source: "system", override: null });
  });
});
