/**
 * Contest-vs-refund recommendation by expected value (requirements REQ-DIS-03).
 *
 *   contest iff  p * amount - (1 - p) * chargebackFee - contestEffort  >  0
 *
 * where p is the base win probability. Winning recovers the amount; losing costs the chargeback
 * fee; contesting always costs the merchant's effort. Low-value disputes therefore favour refund.
 *
 * Pure functions: no database access, no imports from src/db.
 */

export type Recommendation = "contest" | "refund";

/** Expected value, in dollars, of contesting a dispute. */
export function contestExpectedValue(
  amountUsd: number,
  winProbability: number,
  chargebackFeeUsd: number,
  contestEffortUsd: number,
): number {
  return winProbability * amountUsd - (1 - winProbability) * chargebackFeeUsd - contestEffortUsd;
}

export type RecommendationSource = "system" | "ai_adjusted";

/**
 * The recommendation the merchant sees (REQ-DIS-03). The system's EV rule decides; the model may
 * override it, and only an override that DIFFERS from the system's recommendation counts. An
 * override that agrees with the system, or no override, leaves the source as "system".
 */
export function resolveFinalRecommendation(
  system: Recommendation,
  override: Recommendation | null | undefined,
): { recommendation: Recommendation; source: RecommendationSource; override: Recommendation | null } {
  if (override && override !== system) return { recommendation: override, source: "ai_adjusted", override };
  return { recommendation: system, source: "system", override: null };
}

/** "contest" only when the expected value is strictly positive; a tie goes to "refund". */
export function computeSystemRecommendation(
  amountUsd: number,
  winProbability: number,
  chargebackFeeUsd: number,
  contestEffortUsd: number,
): Recommendation {
  const ev = contestExpectedValue(amountUsd, winProbability, chargebackFeeUsd, contestEffortUsd);
  return ev > 0 ? "contest" : "refund";
}
