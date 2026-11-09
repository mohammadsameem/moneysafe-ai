import { describe, expect, it } from "vitest";
import { computeEvidenceCompleteness } from "../evidence-completeness";
import { clampLlmAdjustment, computeBaseWinProbability, computeWinProbability, toWinLikelihoodLabel } from "../win-probability";
import { FULL_DELIVERED, SEED_C_EVIDENCE, SEED_D_EVIDENCE, SEED_E_EVIDENCE } from "./fixtures";

describe("base win probability and the final clamp (seeded values)", () => {
  it("SEED-C: INR, completeness 100, Delivered -> A40 + B30 + C20 = 90/90 = 1.000, shown as 0.95", () => {
    const completeness = computeEvidenceCompleteness(SEED_C_EVIDENCE);
    expect(completeness).toBe(100);
    const base = computeBaseWinProbability(completeness, SEED_C_EVIDENCE, "item_not_received");
    expect(base).toBeCloseTo(1.0, 10);
    expect(computeWinProbability(base, 0)).toBe(0.95); // upper clamp
  });

  it("SEED-D: NAD, completeness 60, no events, no comms -> A24 + B0 + C0 = 24/90 ~ 0.267", () => {
    const completeness = computeEvidenceCompleteness(SEED_D_EVIDENCE);
    expect(completeness).toBe(60);
    const base = computeBaseWinProbability(completeness, SEED_D_EVIDENCE, "not_as_described");
    expect(base).toBeCloseTo(24 / 90, 10);
    expect(computeWinProbability(base, 0)).toBeCloseTo(24 / 90, 10); // not clamped
  });

  it("SEED-E: INR, completeness 75, In Transit only -> A30 + B0 + C10 = 40/90 ~ 0.444", () => {
    const completeness = computeEvidenceCompleteness(SEED_E_EVIDENCE);
    expect(completeness).toBe(75);
    const base = computeBaseWinProbability(completeness, SEED_E_EVIDENCE, "item_not_received");
    expect(base).toBeCloseTo(40 / 90, 10);
    expect(computeWinProbability(base, 0)).toBeCloseTo(40 / 90, 10); // not clamped
  });

  it("NAD best case: completeness 100 with buyer comms -> A40 + B0 + C10 = 50/90 ~ 0.556 (a Delivered scan adds nothing)", () => {
    const completeness = computeEvidenceCompleteness(FULL_DELIVERED);
    expect(completeness).toBe(100);
    const base = computeBaseWinProbability(completeness, FULL_DELIVERED, "not_as_described");
    expect(base).toBeCloseTo(50 / 90, 10);
  });
});

describe("computeWinProbability clamps to [0.05, 0.95]", () => {
  it("(1.0, +0.2) -> 0.95", () => {
    expect(computeWinProbability(1.0, 0.2)).toBe(0.95);
  });

  it("(0.0, -0.2) -> 0.05", () => {
    expect(computeWinProbability(0.0, -0.2)).toBe(0.05);
  });

  it("(0.5, +0.1) -> 0.6 with no clamping", () => {
    expect(computeWinProbability(0.5, 0.1)).toBeCloseTo(0.6, 10);
  });
});

describe("clampLlmAdjustment (the model can move the number by at most 0.1)", () => {
  it("passes small adjustments through unchanged", () => {
    expect(clampLlmAdjustment(0)).toBe(0);
    expect(clampLlmAdjustment(0.05)).toBe(0.05);
    expect(clampLlmAdjustment(-0.1)).toBe(-0.1);
    expect(clampLlmAdjustment(0.1)).toBe(0.1);
  });

  it("clamps anything larger, including the schema's widest accepted values", () => {
    expect(clampLlmAdjustment(0.1000001)).toBe(0.1);
    expect(clampLlmAdjustment(0.5)).toBe(0.1);
    expect(clampLlmAdjustment(-0.5)).toBe(-0.1);
    expect(clampLlmAdjustment(1e9)).toBe(0.1);
  });

  it("treats NaN and infinities as no adjustment", () => {
    expect(clampLlmAdjustment(Number.NaN)).toBe(0);
    expect(clampLlmAdjustment(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampLlmAdjustment(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("combined with the final clamp: SEED-C (base 1.0) with a +0.5 answer still shows 0.95; SEED-D (0.267) with -0.5 shows 0.167", () => {
    expect(computeWinProbability(1.0, clampLlmAdjustment(0.5))).toBe(0.95);
    expect(computeWinProbability(24 / 90, clampLlmAdjustment(-0.5))).toBeCloseTo(24 / 90 - 0.1, 10);
    expect(computeWinProbability(0.04, clampLlmAdjustment(-0.5))).toBe(0.05);
  });
});

describe("toWinLikelihoodLabel thresholds", () => {
  it("Strong >= 0.70, Moderate 0.40-0.69, Weak < 0.40", () => {
    expect(toWinLikelihoodLabel(0.95)).toBe("Strong");
    expect(toWinLikelihoodLabel(0.7)).toBe("Strong");
    expect(toWinLikelihoodLabel(0.6999)).toBe("Moderate");
    expect(toWinLikelihoodLabel(0.4)).toBe("Moderate");
    expect(toWinLikelihoodLabel(0.3999)).toBe("Weak");
    expect(toWinLikelihoodLabel(0.05)).toBe("Weak");
  });
});
