/**
 * A REAL PayPal dispute that PayPal has closed: how that maps onto this app's statuses, and the one place the local
 * record is updated from it.
 *
 * The rule (and what is deliberately NOT done): when PayPal reports a dispute as closed, the local dispute is marked
 * resolved with PayPal's outcome, and nothing else happens. No approval is created, no action is executed and the
 * learning loop is not touched, because the merchant did not decide this inside the app, so it says nothing about the
 * scoring weights and must not move "Dollars protected" or "Chargeback fees avoided".
 */
import type { Dispute } from "@/db/schema";

/** PayPal `dispute_outcome.outcome_code` and the closest local meaning. Anything not listed is "closed" (no money outcome claimed). */
export type ResolvedOnPayPal = { status: Extract<Dispute["status"], `resolved_${string}`>; outcome: Dispute["outcome"]; paypalOutcome: string | null };

const BUYER_FAVOUR = "RESOLVED_BUYER_FAVOUR";
const SELLER_FAVOUR = "RESOLVED_SELLER_FAVOUR";

export interface PayPalClosedState {
  status?: string | null;
  disputeState?: string | null;
  outcomeCode?: string | null;
  outcomeReason?: string | null;
}

/** True when PayPal considers the dispute finished (it can no longer be acted on). */
export function isClosedOnPayPal(s: PayPalClosedState): boolean {
  return s.status === "RESOLVED" || s.disputeState === "RESOLVED" || Boolean(s.outcomeCode);
}

/**
 * The local status and outcome for a dispute PayPal has closed.
 *   RESOLVED_BUYER_FAVOUR  -> resolved_refunded / refunded   (the buyer got the money back, however it happened)
 *   RESOLVED_SELLER_FAVOUR -> resolved_won / won
 *   anything else (cancelled by the buyer, denied, withdrawn, unknown) -> resolved_closed, no outcome claimed
 */
export function mapPayPalResolution(s: PayPalClosedState): ResolvedOnPayPal {
  const code = s.outcomeCode ?? null;
  if (code === BUYER_FAVOUR) return { status: "resolved_refunded", outcome: "refunded", paypalOutcome: code };
  if (code === SELLER_FAVOUR) return { status: "resolved_won", outcome: "won", paypalOutcome: code };
  return { status: "resolved_closed", outcome: null, paypalOutcome: code };
}

/** The sentence shown on the page: what PayPal says happened. */
export function describeResolution(r: ResolvedOnPayPal, reason?: string | null): string {
  const why = reason ? ` (${reason.toLowerCase().replace(/_/g, " ")})` : "";
  if (r.status === "resolved_refunded") return `PayPal closed this dispute in the buyer's favour${why}. The buyer was refunded.`;
  if (r.status === "resolved_won") return `PayPal closed this dispute in your favour${why}.`;
  return `PayPal closed this dispute${r.paypalOutcome ? ` (${r.paypalOutcome.toLowerCase().replace(/_/g, " ")})` : ""}${why}. No refund or win is recorded here.`;
}
