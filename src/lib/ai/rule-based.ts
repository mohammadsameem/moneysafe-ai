/**
 * Rule-based results used whenever the model is unavailable (no key, budget reached, provider
 * error, or an answer that failed validation). They are deterministic, built only from the
 * order's own signals, and written in the same plain English the seeded explanations use.
 */
import { HIGH_VALUE_THRESHOLD_USD, RELATIVE_VALUE_MULTIPLE } from "@/lib/scoring";
import type { PromptOrder, PromptSignal } from "./prompts";

const VERDICT_WORD = { ship: "Ship", verify: "Verify first", hold: "Hold" } as const;

const usd = (amount: number): string => `$${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)}`;

const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five", "Six"];

/** What a fired signal means, as a phrase that continues "... fired:". */
function describeSignal(signal: string, order: PromptOrder): string | null {
  switch (signal) {
    case "country_mismatch":
      return `the billing country (${order.billingCountry}) differs from the shipping country (${order.shippingCountry})`;
    case "first_time_high_value":
      return `a first-time buyer is spending ${usd(order.amountUsd)}, above the ${usd(HIGH_VALUE_THRESHOLD_USD)} high-value line`;
    case "rush_shipping":
      return `${order.shippingMethod} shipping was chosen`;
    case "high_relative_value":
      return `the order is more than ${RELATIVE_VALUE_MULTIPLE} times your usual order value`;
    case "disposable_email":
      return "the buyer's email looks like a disposable address";
    case "repeated_attempts":
      return `there were ${order.paymentAttemptCount} payment attempts`;
    default:
      return null; // a signal this version does not know: leave it out rather than guess
  }
}

const CLOSING = {
  ship: "These are common among honest buyers, so you can ship as normal.",
  verify: "A quick confirmation with the buyer is worth doing before you ship.",
  hold: "Hold this order until you have confirmed the buyer's details.",
} as const;

function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 1) return phrases.join("");
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join("; ")}; and ${phrases[phrases.length - 1]}`;
}

/** The plain-English explanation used when no model answer is available. At most about 520 characters. */
export function ruleBasedExplanation(order: PromptOrder, signals: readonly PromptSignal[]): string {
  const phrases = signals
    .filter((s) => s.active)
    .map((s) => describeSignal(s.signal, order))
    .filter((p): p is string => p !== null);

  const head = `This order scores ${order.riskScore} out of 100 (${VERDICT_WORD[order.verdict]}).`;
  if (phrases.length === 0) return `${head} No risk signals fired, so you can ship as normal.`;

  const count = COUNT_WORD[phrases.length] ?? String(phrases.length);
  const fired = `${count} ${phrases.length === 1 ? "signal" : "signals"} fired: ${joinPhrases(phrases)}.`;
  return `${head} ${fired} ${CLOSING[order.verdict]}`;
}

/** The static verification message used when no model answer is available. Never names the buyer or the score. */
export function staticVerificationDraft(signals: readonly PromptSignal[]): { subject: string; body: string } {
  const active = new Set(signals.filter((s) => s.active).map((s) => s.signal));
  const reason = active.has("country_mismatch")
    ? "Because the billing and delivery countries are different, I like to confirm orders like this before they ship."
    : active.has("first_time_high_value")
      ? "As this is a larger first order, I like to confirm the details before it ships."
      : "I like to confirm some orders before they ship.";
  return {
    subject: "Quick confirmation for your order",
    body: [
      "Hi there,",
      "",
      `Thank you for your order. ${reason}`,
      "",
      "Could you reply to confirm that the delivery address is correct and that you placed this order? As soon as I hear back I will pack it and send it out.",
      "",
      "Thank you,",
      "[Your name]",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Dispute fallbacks (used when the model is unavailable)
// ---------------------------------------------------------------------------
export interface RuleBasedDisputeInput {
  reason: "item_not_received" | "not_as_described";
  amountUsd: number;
  completeness: number;
  baseWinProbability: number;
  systemRecommendation: "contest" | "refund";
  expectedValueUsd: number;
  chargebackFeeUsd: number;
  contestEffortUsd: number;
}

const signedUsd = (n: number): string => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

/** The reasoning shown when the AI step is unavailable: only the system's own numbers, in plain English. */
export function ruleBasedDisputeReasoning(i: RuleBasedDisputeInput): string {
  const what = i.reason === "item_not_received" ? "an item-not-received" : "a not-as-described";
  const verdict =
    i.systemRecommendation === "contest"
      ? "contesting is worth it on these numbers"
      : "a refund costs less than the expected cost of contesting";
  return (
    `This is ${what} dispute. Evidence completeness is ${i.completeness}%, which gives a base win likelihood of ${Math.round(i.baseWinProbability * 100)}%. ` +
    `At ${usd(i.amountUsd)}, contesting has an expected value of about ${signedUsd(i.expectedValueUsd)} after the ${usd(i.chargebackFeeUsd)} chargeback fee and ${usd(i.contestEffortUsd)} effort cost, so ${verdict}. ` +
    `Recommendation: ${i.systemRecommendation}. The AI step was unavailable, so this is the system's rule-based recommendation.`
  );
}

export interface RuleBasedDraftInput {
  reason: "item_not_received" | "not_as_described";
  amountUsd: number;
  itemName: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  shippedOn: string | null;
  /** Latest scan status and date, if there are scans. */
  lastScan: { status: string; date: string } | null;
  deliveredOn: string | null;
}

const cleanName = (name: string | null): string => {
  const text = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  return text === "" ? "this order" : text;
};

/** A factual draft built only from what is on file. The merchant reviews and may edit it before anything is sent. */
export function ruleBasedDraftResponse(i: RuleBasedDraftInput): string {
  const item = cleanName(i.itemName);
  const lines: string[] = ["Hello PayPal Dispute Team,", ""];

  if (i.reason === "item_not_received") {
    lines.push(`I am responding to the item-not-received claim on this order (${item}, ${usd(i.amountUsd)}).`);
    if (i.trackingNumber) {
      lines.push(
        `The order shipped with ${i.carrier ?? "the carrier"} under tracking number ${i.trackingNumber}${i.shippedOn ? ` on ${i.shippedOn}` : ""}.`,
      );
    } else {
      lines.push("I do not have a tracking number on file for this order.");
    }
    if (i.deliveredOn) {
      lines.push(`The carrier's scan history shows the parcel was marked Delivered on ${i.deliveredOn}.`);
    } else if (i.lastScan) {
      lines.push(`The carrier's latest scan is "${i.lastScan.status}" on ${i.lastScan.date}, so the parcel has not been reported lost or returned.`);
    }
    lines.push("", "I have attached the invoice, line items, delivery address and tracking details, and I ask that the claim be decided in my favour.");
  } else {
    lines.push(`I am responding to the not-as-described claim on this order (${item}, ${usd(i.amountUsd)}).`);
    lines.push("I believe the item matches its listing. The invoice and line items on file show exactly what was ordered and sent.");
    lines.push("", "I am happy to provide any further details you need to review the claim.");
  }

  lines.push("", "Thank you,", "[Your name]");
  return lines.join("\n");
}
