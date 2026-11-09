import { createHash } from "node:crypto";
import type { SignalWeights } from "@/db/schema";
import { toSignalWeightValues } from "@/lib/orders/weights";

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

/** The fingerprint of the live state: the outcome stats and the active signal_weights row. */
export function currentFingerprint(stats: { total: number; latestOutcomeId: string | null }, row: SignalWeights): string {
  return computeInsightsFingerprint({
    outcomeCount: stats.total,
    latestOutcomeId: stats.latestOutcomeId,
    proposalCreatedAt: row.proposalCreatedAt,
    weights: toSignalWeightValues(row),
  });
}

/**
 * SHA-256 over a canonical, fixed-order encoding of the inputs.
 * This is the single source of truth: the seed runner stores it in insights_cache, and the
 * Insights write paths recompute it to decide whether the summary needs regenerating.
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
