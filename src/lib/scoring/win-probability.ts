/**
 * Base win probability and win-likelihood label (design 6.4, requirements REQ-DIS-03).
 *
 * The SYSTEM computes the base probability from verifiable evidence. The LLM may only nudge it
 * by a small, separately clamped amount, and the result is always kept inside [0.05, 0.95]
 * because no estimate should claim certainty either way.
 *
 * Pure functions: no database access, no imports from src/db.
 */
import { DELIVERED_STATUS, trackingStatuses, type ArtefactInput } from "./evidence-completeness";

export type DisputeReason = "item_not_received" | "not_as_described";
export type WinLikelihoodLabel = "Strong" | "Moderate" | "Weak";

/** The rubric's maximum total (A 40 + B 30 + C 20). Probabilities are divided by this. */
export const RUBRIC_MAX_POINTS = 90;
export const WIN_PROBABILITY_MIN = 0.05;
export const WIN_PROBABILITY_MAX = 0.95;
export const STRONG_THRESHOLD = 0.7;
export const MODERATE_THRESHOLD = 0.4;

/**
 * Deterministic base win probability, 0-1.
 *
 *   A = completeness / 100 * 40                    (scaled evidence completeness, max 40)
 *   B = 30 if item_not_received AND a Delivered scan exists, else 0   (never for not_as_described)
 *   C = reason bonus:
 *         item_not_received: 20 if delivered, 10 if tracking exists but not delivered, else 0
 *         not_as_described : 10 if buyer communications exist, else 0
 *   base = clamp(A + B + C, 0, 90) / 90
 *
 * `completeness` is the 0-100 score from computeEvidenceCompleteness(artefacts).
 */
export function computeBaseWinProbability(
  completeness: number,
  artefacts: readonly ArtefactInput[],
  reason: DisputeReason,
): number {
  const statuses = trackingStatuses(artefacts);
  const delivered = statuses.includes(DELIVERED_STATUS);
  const hasTracking = statuses.length > 0;
  const hasComms = artefacts.some((a) => a.artefactType === "buyer_communication");

  // Multiply before dividing so round completeness values (e.g. 60 -> 24) stay exact.
  const a = (completeness * 40) / 100;

  let b = 0;
  let c = 0;
  if (reason === "item_not_received") {
    b = delivered ? 30 : 0;
    c = delivered ? 20 : hasTracking ? 10 : 0;
  } else {
    c = hasComms ? 10 : 0;
  }

  const total = Math.min(RUBRIC_MAX_POINTS, Math.max(0, a + b + c));
  return total / RUBRIC_MAX_POINTS;
}

/** The LLM may nudge the base probability by at most this much in either direction (REQ-DIS-03). */
export const LLM_ADJUSTMENT_LIMIT = 0.1;

/**
 * Clamp whatever the model returned to [-0.1, +0.1]. A non-finite value (NaN, Infinity) counts as
 * no adjustment, so a malformed answer can never move the number.
 */
export function clampLlmAdjustment(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(LLM_ADJUSTMENT_LIMIT, Math.max(-LLM_ADJUSTMENT_LIMIT, raw));
}

/** final win probability = clamp(base + adjustment, 0.05, 0.95) */
export function computeWinProbability(base: number, llmAdjustment: number): number {
  return Math.min(WIN_PROBABILITY_MAX, Math.max(WIN_PROBABILITY_MIN, base + llmAdjustment));
}

/** Strong >= 0.70, Moderate 0.40-0.69, Weak < 0.40. */
export function toWinLikelihoodLabel(probability: number): WinLikelihoodLabel {
  if (probability >= STRONG_THRESHOLD) return "Strong";
  if (probability >= MODERATE_THRESHOLD) return "Moderate";
  return "Weak";
}
