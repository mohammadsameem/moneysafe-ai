/**
 * Dashboard metrics (M4-04, REQ-DASH-01). Pure: rows in, numbers out.
 *
 * Definitions (no double counting):
 *   value_under_review       sum of order amounts where the verdict is Hold (exposure, not an outcome)
 *   disputes_won             how many disputes were won, and their disputed amounts
 *   chargeback_fees_avoided  accepted refunds x the chargeback fee (the fee only, never the order value)
 *   dollars_protected        disputed amounts of WON disputes only (never mixed with the fees above)
 *   dollars_protected_simulated  the part of dollars_protected that came from simulated outcomes
 */
import type { Verdict } from "@/lib/scoring";

export interface OrderRow {
  amountUsd: number;
  verdict: Verdict | null;
  isSeed: boolean;
}

export interface DisputeOutcomeRow {
  outcome: "won" | "lost" | "refunded" | null;
  amountUsd: number;
  /** The outcome was simulated (Simulate outcome, or a simulated refund). */
  simulated: boolean;
  isSeed: boolean;
}

export interface DashboardMetrics {
  value_under_review: { amountUsd: number; orderCount: number; includesDemoData: boolean };
  disputes_won: { count: number; amountUsd: number; includesDemoData: boolean };
  chargeback_fees_avoided: { count: number; feeUsd: number; amountUsd: number; includesDemoData: boolean };
  dollars_protected: { amountUsd: number; includesDemoData: boolean };
  dollars_protected_simulated: { amountUsd: number };
  verdict_distribution: { ship: number; verify: number; hold: number; total: number; includesDemoData: boolean };
}

const cents = (n: number): number => Math.round(n * 100) / 100;

export function computeDashboardMetrics(orders: readonly OrderRow[], disputes: readonly DisputeOutcomeRow[], chargebackFeeUsd: number): DashboardMetrics {
  const held = orders.filter((o) => o.verdict === "hold");
  const won = disputes.filter((d) => d.outcome === "won");
  const refunded = disputes.filter((d) => d.outcome === "refunded");
  const scored = orders.filter((o) => o.verdict !== null);
  const sum = (rows: readonly { amountUsd: number }[]) => cents(rows.reduce((total, r) => total + r.amountUsd, 0));
  const demo = (rows: readonly { isSeed: boolean }[]) => rows.some((r) => r.isSeed);
  const count = (v: Verdict) => scored.filter((o) => o.verdict === v).length;

  return {
    value_under_review: { amountUsd: sum(held), orderCount: held.length, includesDemoData: demo(held) },
    disputes_won: { count: won.length, amountUsd: sum(won), includesDemoData: demo(won) },
    chargeback_fees_avoided: { count: refunded.length, feeUsd: chargebackFeeUsd, amountUsd: cents(refunded.length * chargebackFeeUsd), includesDemoData: demo(refunded) },
    dollars_protected: { amountUsd: sum(won), includesDemoData: demo(won) },
    dollars_protected_simulated: { amountUsd: sum(won.filter((d) => d.simulated)) },
    verdict_distribution: { ship: count("ship"), verify: count("verify"), hold: count("hold"), total: scored.length, includesDemoData: demo(scored) },
  };
}
