import type { SignalWeights } from "@/db/schema";
import type { SignalWeightValues } from "@/lib/scoring";

/**
 * Map the camelCase `signal_weights` row to the snake_case values the scoring engine takes.
 * This is the only place the two naming styles meet.
 */
export function toSignalWeightValues(row: SignalWeights): SignalWeightValues {
  return {
    country_mismatch: row.countryMismatch,
    first_time_high_value: row.firstTimeHighValue,
    rush_shipping: row.rushShipping,
    high_relative_value: row.highRelativeValue,
    disposable_email: row.disposableEmail,
    repeated_attempts: row.repeatedAttempts,
  };
}
