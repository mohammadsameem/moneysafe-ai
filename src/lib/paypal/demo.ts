/**
 * Demo Mode helpers (requirements REQ-DEMO-01, REQ-DIS-09).
 *
 *  - Reads fall back to seeded data when PayPal is unreachable, fails, or credentials are absent,
 *    and the result is flagged `isDemo` so the UI shows the "Demo data" badge.
 *  - Writes are simulated only when DEMO_MODE=true or the dispute is a seed/demo dispute. A live
 *    write failure on a real dispute is NOT simulated; the caller surfaces the error and allows
 *    a retry with the same PayPal-Request-Id.
 */
import { isDemoModeEnabled } from "../env";
import { PayPalError } from "./errors";

export function isDemoMode(): boolean {
  return isDemoModeEnabled();
}

/** True when a dispute write must be simulated instead of sent to PayPal. */
export function shouldSimulateWrite(
  record: { isSeed?: boolean | null; isDemo?: boolean | null },
  demoMode: boolean = isDemoMode(),
): boolean {
  return demoMode || record.isSeed === true || record.isDemo === true;
}

export type DemoReason = "demo_mode" | "no_credentials" | "paypal_error";

export interface DemoResult<T> {
  data: T;
  /** True when `data` is seeded rather than a live PayPal response. */
  isDemo: boolean;
  reason?: DemoReason;
}

export interface DemoFallbackOptions {
  demoMode?: boolean;
  /**
   * Called when seeded data is used. Bind this to the agent-activity logger so each fallback
   * shows up as a "simulated" step. The message contains no credentials.
   */
  onFallback?: (info: { reason: DemoReason; message?: string }) => void | Promise<void>;
}

/**
 * Run a live PayPal READ, falling back to seeded data.
 *
 * @param liveCall the PayPal request, or null when no credentials are configured
 * @param seed     returns the seeded record for this call (the caller looks it up by its seed key)
 */
export async function withDemoFallback<T>(
  liveCall: (() => Promise<T>) | null,
  seed: () => T | Promise<T>,
  options: DemoFallbackOptions = {},
): Promise<DemoResult<T>> {
  const notify = async (reason: DemoReason, message?: string) => {
    try {
      await options.onFallback?.({ reason, message });
    } catch {
      /* logging must never change the outcome */
    }
  };

  if (options.demoMode ?? isDemoMode()) {
    await notify("demo_mode");
    return { data: await seed(), isDemo: true, reason: "demo_mode" };
  }
  if (!liveCall) {
    await notify("no_credentials");
    return { data: await seed(), isDemo: true, reason: "no_credentials" };
  }
  try {
    return { data: await liveCall(), isDemo: false };
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err; // a bug, not an outage: do not hide it behind seed data
    await notify("paypal_error", err.message);
    return { data: await seed(), isDemo: true, reason: "paypal_error" };
  }
}
