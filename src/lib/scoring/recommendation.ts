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
