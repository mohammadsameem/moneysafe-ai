import { describe, expect, it } from "vitest";
import { computeEvidenceCompleteness } from "../evidence-completeness";
import { computeBaseWinProbability, computeWinProbability } from "../win-probability";
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
