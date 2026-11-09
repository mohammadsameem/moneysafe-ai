import { describe, expect, it } from "vitest";
import { computeSystemRecommendation, contestExpectedValue } from "../recommendation";

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
