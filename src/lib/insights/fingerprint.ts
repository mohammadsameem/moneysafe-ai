import { createHash } from "node:crypto";

/**
 * The inputs that decide whether the cached Insights AI summary is stale (design.md section 7.4):
 * outcome count + latest outcome id + proposal_created_at + active weights.
 */
export interface InsightsFingerprintInput {
  outcomeCount: number;
  latestOutcomeId: string | null;
  proposalCreatedAt: string | null;
  weights: {
    country_mismatch: number;
    first_time_high_value: number;
    rush_shipping: number;
    high_relative_value: number;
    disposable_email: number;
    repeated_attempts: number;
  };
}

/**
 * SHA-256 over a canonical, fixed-order encoding of the inputs.
 * This is the single source of truth: the seed runner stores it in insights_cache, and the
 * Insights write paths (M4) recompute it to decide whether the summary needs regenerating.
 */
export function computeInsightsFingerprint(input: InsightsFingerprintInput): string {
  const w = input.weights;
  const canonical = JSON.stringify([
    input.outcomeCount,
    input.latestOutcomeId,
    input.proposalCreatedAt,
    [
      w.country_mismatch,
      w.first_time_high_value,
      w.rush_shipping,
      w.high_relative_value,
      w.disposable_email,
      w.repeated_attempts,
    ],
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
