/**
 * Explainable risk signals (design 6.1, requirements REQ-ORD-02).
 *
 * Pure functions only: no database access and no imports from src/db. The merchant baseline
 * average order value is always passed in by the caller (it comes from the `settings` row).
 *
 * This is a rule-based score of explainable signals. It is not a trained fraud model.
 */

export const SIGNAL_NAMES = [
  "country_mismatch",
  "first_time_high_value",
  "rush_shipping",
  "high_relative_value",
  "disposable_email",
  "repeated_attempts",
] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];
/** One weight per signal. Keys match `signal_breakdown[].signal` and the weight-proposal schema. */
export type SignalWeightValues = Record<SignalName, number>;

export const DEFAULT_SIGNAL_WEIGHTS: Readonly<SignalWeightValues> = Object.freeze({
  country_mismatch: 20,
  first_time_high_value: 20,
  rush_shipping: 15,
  high_relative_value: 20,
  disposable_email: 15,
  repeated_attempts: 10,
});

/** A first-time buyer spending more than this triggers `first_time_high_value`. */
export const HIGH_VALUE_THRESHOLD_USD = 200;
/** An order above this multiple of the merchant baseline triggers `high_relative_value`. */
export const RELATIVE_VALUE_MULTIPLE = 3;
/** This many payment attempts (or more) triggers `repeated_attempts`. */
export const REPEATED_ATTEMPTS_THRESHOLD = 3;
/** Score at or above which the verdict is "verify" / "hold". */
export const VERDICT_THRESHOLDS = Object.freeze({ verifyFrom: 40, holdFrom: 70 });

export type Verdict = "ship" | "verify" | "hold";

/** The order fields the signals read. A database order row satisfies this structurally. */
export interface ScoringOrder {
  buyerEmail: string;
  buyerIsFirstTime: boolean;
  paymentAttemptCount: number;
  shippingMethod: string;
  billingCountry: string;
  shippingCountry: string;
  amountUsd: number;
}

export interface SignalResult {
  signal: SignalName;
  active: boolean;
  weight: number;
}

/** Well-known throwaway-mail services. Matches the domain itself and any subdomain of it. */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.biz",
  "guerrillamail.de",
  "guerrillamailblock.com",
  "grr.la",
  "sharklasers.com",
  "yopmail.com",
  "yopmail.net",
  "yopmail.fr",
  "tempmail.com",
  "temp-mail.org",
  "tempmailo.com",
  "tempinbox.com",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.net",
  "10minutemail.com",
  "10minutemail.net",
  "dispostable.com",
  "getnada.com",
  "maildrop.cc",
  "mailnesia.com",
  "mintemail.com",
  "fakeinbox.com",
  "spamgourmet.com",
  "mohmal.com",
  "emailondeck.com",
  "moakt.com",
  "discard.email",
  "burnermail.io",
  "mailcatch.com",
  "spambox.us",
  "mytemp.email",
]);

/** True when the email's domain (or a parent domain) is a known disposable-mail service. */
export function isDisposableDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!domain) return false;
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

const normaliseCountry = (code: string): string => code.trim().toUpperCase();

/**
 * Evaluate the six signals for an order. Always returns all six, in a fixed order, so the
 * caller can store the full breakdown and the UI can show which ones fired.
 *
 * `baselineAvgUsd` is the merchant's baseline average order value (settings row, default $85).
 * It must be a positive number; the caller owns that.
 */
export function evaluateSignals(
  order: ScoringOrder,
  weights: SignalWeightValues,
  baselineAvgUsd: number,
): SignalResult[] {
  return [
    {
      signal: "country_mismatch",
      active: normaliseCountry(order.billingCountry) !== normaliseCountry(order.shippingCountry),
      weight: weights.country_mismatch,
    },
    {
      signal: "first_time_high_value",
      active: order.buyerIsFirstTime && order.amountUsd > HIGH_VALUE_THRESHOLD_USD,
      weight: weights.first_time_high_value,
    },
    {
      signal: "rush_shipping",
      active: order.shippingMethod === "overnight" || order.shippingMethod === "rush",
      weight: weights.rush_shipping,
    },
    {
      signal: "high_relative_value",
      active: order.amountUsd > RELATIVE_VALUE_MULTIPLE * baselineAvgUsd,
      weight: weights.high_relative_value,
    },
    {
      signal: "disposable_email",
      active: isDisposableDomain(order.buyerEmail),
      weight: weights.disposable_email,
    },
    {
      signal: "repeated_attempts",
      active: order.paymentAttemptCount >= REPEATED_ATTEMPTS_THRESHOLD,
      weight: weights.repeated_attempts,
    },
  ];
}

/** Sum of the active signals' weights, clamped to 100. */
export function computeRiskScore(signals: readonly SignalResult[]): number {
  const raw = signals.filter((s) => s.active).reduce((sum, s) => sum + s.weight, 0);
  return Math.min(100, raw);
}

/** 0-39 ship (low), 40-69 verify (medium), 70-100 hold (high). */
export function toVerdict(score: number): Verdict {
  if (score >= VERDICT_THRESHOLDS.holdFrom) return "hold";
  if (score >= VERDICT_THRESHOLDS.verifyFrom) return "verify";
  return "ship";
}
