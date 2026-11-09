/** The PayPal service layer: the single import boundary for everything that talks to PayPal. */
import { getPayPalCredentials } from "../env";
import { createPayPalClient, type PayPalClient } from "./client";

export { createPayPalClient, PAYPAL_SANDBOX_BASE_URL, type PayPalClient } from "./client";
export { ApprovalRequiredError, PayPalError } from "./errors";
export { addTracking, captureOrder, createOrder, getOrder, toMoney } from "./orders";
export type { AddTrackingInput, CapturedOrder, CreateOrderInput, CreatedOrder, PayPalOrder } from "./orders";
export { isDemoMode, shouldSimulateWrite, withDemoFallback } from "./demo";
export type { DemoFallbackOptions, DemoReason, DemoResult } from "./demo";
export { requireApproval } from "./approval-gate";
export type { ApprovalLookup, ApprovalRecordLite, DisputeActionType } from "./approval-gate";
export { getDispute, listDisputes } from "./disputes-read";
export type { ListDisputesOptions, PayPalDispute } from "./disputes-read";
export { acceptClaim, submitEvidence } from "./disputes";
export type { AcceptClaimPayload, DisputeWriteDeps, PayPalDisputeWrite, ProvideEvidencePayload } from "./disputes";

let shared: PayPalClient | null | undefined;

/** The shared sandbox client, or null when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. */
export function getPayPalClient(): PayPalClient | null {
  if (shared === undefined) {
    const credentials = getPayPalCredentials();
    shared = credentials ? createPayPalClient(credentials) : null;
  }
  return shared;
}
