/**
 * The rules that keep a weight proposal safe (REQ-LL-02). Pure.
 *
 * The model proposes weights; THIS code decides what is stored. Each weight may move by at most
 * 3 points per cycle and always stays between 5 and 30, whatever the model says.
 */
import type { SignalWeights } from "@/db/schema";
import { DEFAULT_SIGNAL_WEIGHTS, SIGNAL_NAMES, type SignalName, type SignalWeightValues } from "@/lib/scoring";

export const WEIGHT_MIN = 5;
export const WEIGHT_MAX = 30;
export const MAX_WEIGHT_DELTA = 3;
/** A new proposal is considered after every 5th resolved dispute (REQ-LL-02). */
export const PROPOSAL_EVERY = 5;
/** The proposal prompt sees at most this many of the most recent outcomes. */
export const OUTCOMES_FOR_PROPOSAL = 20;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export interface CappedProposal {
  weights: SignalWeightValues;
  /** True when the model asked for something outside the rules and the system limited it. */
  capped: boolean;
}

/**
 * Delta cap first (|change| <= 3), then the absolute range [5, 30]:
 *   delta = clamp(proposed - current, -3, +3);  final = clamp(current + delta, 5, 30)
 */
export function capProposal(current: SignalWeightValues, proposed: SignalWeightValues): CappedProposal {
  const weights = { ...current };
  let capped = false;
  for (const signal of SIGNAL_NAMES) {
    const delta = clamp(Math.round(proposed[signal] - current[signal]), -MAX_WEIGHT_DELTA, MAX_WEIGHT_DELTA);
    weights[signal] = clamp(current[signal] + delta, WEIGHT_MIN, WEIGHT_MAX);
    if (weights[signal] !== proposed[signal]) capped = true;
  }
  return { weights, capped };
}

export interface WeightChange {
  signal: SignalName;
  from: number;
  to: number;
  delta: number;
}

/** Every signal whose weight differs, in the fixed signal order. */
export function weightChanges(from: SignalWeightValues, to: SignalWeightValues): WeightChange[] {
  return SIGNAL_NAMES.filter((s) => from[s] !== to[s]).map((signal) => ({ signal, from: from[signal], to: to[signal], delta: to[signal] - from[signal] }));
}

export const hasWeightChange = (from: SignalWeightValues, to: SignalWeightValues): boolean => weightChanges(from, to).length > 0;

/** The weights proposed on the active row, or null when no proposal is pending (or it is incomplete). */
export function proposedWeights(row: SignalWeights): SignalWeightValues | null {
  if (row.proposalCreatedAt === null) return null;
  const values = [
    row.proposedCountryMismatch,
    row.proposedFirstTimeHighValue,
    row.proposedRushShipping,
    row.proposedHighRelativeValue,
    row.proposedDisposableEmail,
    row.proposedRepeatedAttempts,
  ];
  if (values.some((v) => v === null)) return null;
  const [country, firstTime, rush, relative, email, attempts] = values as number[];
  return {
    country_mismatch: country!,
    first_time_high_value: firstTime!,
    rush_shipping: rush!,
    high_relative_value: relative!,
    disposable_email: email!,
    repeated_attempts: attempts!,
  };
}

/** The starting weights every delta on the Insights page is measured against. */
export const BASELINE_WEIGHTS: Readonly<SignalWeightValues> = DEFAULT_SIGNAL_WEIGHTS;
