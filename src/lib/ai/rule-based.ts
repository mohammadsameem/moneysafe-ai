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
