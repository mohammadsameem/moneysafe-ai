/**
 * The check made just before a REAL PayPal dispute is acted on: PayPal itself must allow the action right now, and Demo
 * Mode must be off (a real dispute is never simulated; if it cannot be sent, it is refused instead).
 */
import { getDispute, type PayPalClient } from "@/lib/paypal";
import type { ApproveDeps } from "./approve";
import { allowedActions, liveBlockReason } from "./paypal-reason";

export function createLiveGate(paypal: PayPalClient | null, demoMode: boolean): NonNullable<ApproveDeps["liveGate"]> {
  return async (dispute, action) => {
    if (demoMode) return { ok: false, message: "Demo Mode is on, so this real PayPal dispute cannot be acted on: nothing would reach PayPal." };
    if (!paypal || !dispute.paypalDisputeId) return { ok: false, message: "PayPal credentials are not configured, so nothing was sent." };
    try {
      const live = await getDispute(paypal, dispute.paypalDisputeId);
      const reason = liveBlockReason(
        {
          paypalDisputeId: dispute.paypalDisputeId,
          reasonCode: live.reason ?? null,
          status: live.status,
          state: live.dispute_state ?? null,
          stage: live.dispute_life_cycle_stage ?? null,
          dueDate: null,
          allowed: allowedActions(live.allowed_response_options),
          readFailed: null,
        },
        action,
      );
      return reason === null ? { ok: true } : { ok: false, message: reason };
    } catch {
      return { ok: false, message: "PayPal could not be read, so nothing was sent. Try again in a moment." };
    }
  };
}
