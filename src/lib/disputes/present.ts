/**
 * Display helpers for disputes (M2-06..08). Pure, so they are unit-tested without a browser.
 *
 * One colour language across the app: green = good for the merchant, amber = needs attention,
 * red = bad or urgent. Text always carries the meaning too, so nothing relies on colour alone.
 */
import type { Dispute } from "@/db/schema";

export type Tone = "good" | "warn" | "bad" | "neutral" | "info";

export const REASON_LABEL: Record<Dispute["reason"], string> = {
  item_not_received: "Item not received",
  not_as_described: "Not as described",
};

export const OUTCOME_LABEL: Record<NonNullable<Dispute["outcome"]>, string> = {
  won: "Won",
  lost: "Lost",
  refunded: "Refunded",
};

export const OUTCOME_TONE: Record<NonNullable<Dispute["outcome"]>, Tone> = {
  won: "good",
  lost: "bad",
  refunded: "warn",
};

export const STATUS_LABEL: Record<Dispute["status"], string> = {
  open: "Needs a decision",
  action_taken: "Sent, awaiting PayPal",
  resolved_won: "Resolved: won",
  resolved_lost: "Resolved: lost",
  resolved_refunded: "Resolved: refunded",
};

export const STATUS_TONE: Record<Dispute["status"], Tone> = {
  open: "warn",
  action_taken: "info",
  resolved_won: "good",
  resolved_lost: "bad",
  resolved_refunded: "warn",
};

export const RECOMMENDATION_LABEL: Record<"contest" | "refund", string> = {
  contest: "Contest",
  refund: "Refund",
};

export function sourceLabel(source: Dispute["recommendationSource"]): string {
  return source === "ai_adjusted" ? "AI-adjusted recommendation" : "System recommendation";
}

export type LikelihoodLabel = NonNullable<Dispute["winLikelihoodLabel"]>;

export const LIKELIHOOD_TONE: Record<LikelihoodLabel, Tone> = {
  Strong: "good",
  Moderate: "warn",
  Weak: "bad",
};

/** Whole percent, 0-100, for a probability in [0, 1]. */
export function percent(probability: number): number {
  return Math.round(Math.min(1, Math.max(0, probability)) * 100);
}

/** "+5 pts" / "-10 pts" / "no change" for the model's adjustment (already clamped by the system). */
export function adjustmentText(llmAdjustment: number | null): string | null {
  if (llmAdjustment === null) return null;
  const points = Math.round(llmAdjustment * 100);
  if (points === 0) return "no change from the system estimate";
  return `${points > 0 ? "+" : ""}${points} pts from the system estimate`;
}

export function money(amountUsd: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountUsd);
}
