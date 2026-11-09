/**
 * Seed-time mirror of the scoring formulas (requirements REQ-EV-02, design 6.3 and 6.4).
 *
 * Used ONLY to pre-compute the seeded dispute analyses from the seeded evidence and to
 * cross-check them against the expected numbers. The real, tested implementations arrive in
 * M1-04 under src/lib/scoring; M1-05 should assert the two agree on the seed data.
 */

export const SEED_CHARGEBACK_FEE_USD = 20; // matches the CHARGEBACK_FEE_USD default
export const SEED_CONTEST_EFFORT_USD = 10; // matches the CONTEST_EFFORT_USD default

export interface ArtefactLike {
  artefactType: string;
  payload: Record<string, unknown>;
}

type Reason = "item_not_received" | "not_as_described";

function scanStatuses(artefacts: ArtefactLike[]): string[] {
  return artefacts
    .filter((a) => a.artefactType === "tracking_events")
    .flatMap((a) => ((a.payload.events as { status: string }[] | undefined) ?? []).map((e) => e.status));
}

/** REQ-EV-02: invoice 15, line items 15, contact 15, tracking info 15, scans 15, Delivered 15, comms 10. */
export function mirrorCompleteness(artefacts: ArtefactLike[]): number {
  const has = (t: string) => artefacts.some((a) => a.artefactType === t);
  const statuses = scanStatuses(artefacts);
  return (
    (has("invoice_summary") ? 15 : 0) +
    (has("line_items") ? 15 : 0) +
    (has("buyer_contact") ? 15 : 0) +
    (has("tracking_info") ? 15 : 0) +
    (statuses.length > 0 ? 15 : 0) +
    (statuses.includes("Delivered") ? 15 : 0) +
    (has("buyer_communication") ? 10 : 0)
  );
}

/** Design 6.4: A = completeness/100*40; B = 30 only for INR with a Delivered scan; C by reason. */
export function mirrorBaseWinProbability(artefacts: ArtefactLike[], reason: Reason): number {
  const completeness = mirrorCompleteness(artefacts);
  const statuses = scanStatuses(artefacts);
  const delivered = statuses.includes("Delivered");
  const inTransitOnly = statuses.length > 0 && !delivered;
  const hasComms = artefacts.some((a) => a.artefactType === "buyer_communication");

  const a = (completeness * 40) / 100; // integer-first so 60 -> exactly 24
  let b = 0;
  let c = 0;
  if (reason === "item_not_received") {
    b = delivered ? 30 : 0;
    c = delivered ? 20 : inTransitOnly ? 10 : 0;
  } else {
    c = hasComms ? 10 : 0; // B never applies to not_as_described
  }
  return Math.min(90, Math.max(0, a + b + c)) / 90;
}

/** win_probability = clamp(base + llm_adjustment, 0.05, 0.95) */
export const mirrorWinProbability = (base: number, llmAdjustment = 0): number =>
  Math.max(0.05, Math.min(0.95, base + llmAdjustment));

export const mirrorLabel = (p: number): "Strong" | "Moderate" | "Weak" =>
  p >= 0.7 ? "Strong" : p >= 0.4 ? "Moderate" : "Weak";

/** contest iff p*amount - (1-p)*fee - effort > 0, with p = base_win_probability. */
export const mirrorRecommendation = (amountUsd: number, baseP: number): "contest" | "refund" =>
  baseP * amountUsd - (1 - baseP) * SEED_CHARGEBACK_FEE_USD - SEED_CONTEST_EFFORT_USD > 0 ? "contest" : "refund";

// ---------------------------------------------------------------------------
// Risk signals (design 6.1), used to cross-check the hand-written seed scores.
// ---------------------------------------------------------------------------
export const SEED_BASELINE_AVG_USD = 85; // settings.merchant_avg_order_value_usd

export const SEED_DEFAULT_WEIGHTS = {
  country_mismatch: 20,
  first_time_high_value: 20,
  rush_shipping: 15,
  high_relative_value: 20,
  disposable_email: 15,
  repeated_attempts: 10,
} as const;

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "yopmail.com",
  "tempmail.com",
  "sharklasers.com",
  "trashmail.com",
]);

export interface OrderLike {
  buyerEmail: string;
  buyerIsFirstTime: boolean;
  paymentAttemptCount: number;
  shippingMethod: string;
  billingCountry: string;
  shippingCountry: string;
  amountUsd: number;
}

export interface SignalLike {
  signal: string;
  active: boolean;
  weight: number;
}

/** The six explainable signals, in a fixed order, with the default weights. */
export function mirrorSignals(o: OrderLike): SignalLike[] {
  const w = SEED_DEFAULT_WEIGHTS;
  const domain = o.buyerEmail.split("@")[1]?.toLowerCase() ?? "";
  return [
    { signal: "country_mismatch", active: o.billingCountry !== o.shippingCountry, weight: w.country_mismatch },
    {
      signal: "first_time_high_value",
      active: o.buyerIsFirstTime && o.amountUsd > 200,
      weight: w.first_time_high_value,
    },
    {
      signal: "rush_shipping",
      active: o.shippingMethod === "overnight" || o.shippingMethod === "rush",
      weight: w.rush_shipping,
    },
    {
      signal: "high_relative_value",
      active: o.amountUsd > 3 * SEED_BASELINE_AVG_USD,
      weight: w.high_relative_value,
    },
    { signal: "disposable_email", active: DISPOSABLE_DOMAINS.has(domain), weight: w.disposable_email },
    { signal: "repeated_attempts", active: o.paymentAttemptCount >= 3, weight: w.repeated_attempts },
  ];
}

export const mirrorRiskScore = (signals: SignalLike[]): number =>
  Math.min(
    100,
    signals.filter((s) => s.active).reduce((sum, s) => sum + s.weight, 0),
  );

/** 0-39 ship, 40-69 verify, 70-100 hold. */
export const mirrorVerdict = (score: number): "ship" | "verify" | "hold" =>
  score <= 39 ? "ship" : score <= 69 ? "verify" : "hold";
