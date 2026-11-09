/**
 * One line of "why" for the two signals that depend on an amount, so the numbers behind a score are on screen:
 * "$320.00 is more than 3 x your usual $85.00 order ($255.00)". Pure; the thresholds come from the scoring engine.
 */
import { formatUsd } from "@/lib/format";
import { HIGH_VALUE_THRESHOLD_USD, RELATIVE_VALUE_MULTIPLE } from "@/lib/scoring";

export function signalDetail(signal: string, amountUsd: number, baselineAvgUsd: number, currency = "USD"): string | null {
  if (signal === "high_relative_value") {
    return `${formatUsd(amountUsd, currency)} > ${RELATIVE_VALUE_MULTIPLE} \u00d7 ${formatUsd(baselineAvgUsd, currency)} usual order = ${formatUsd(RELATIVE_VALUE_MULTIPLE * baselineAvgUsd, currency)}`;
  }
  if (signal === "first_time_high_value") {
    return `${formatUsd(amountUsd, currency)} > ${formatUsd(HIGH_VALUE_THRESHOLD_USD, currency)} for a first-time buyer`;
  }
  return null;
}
