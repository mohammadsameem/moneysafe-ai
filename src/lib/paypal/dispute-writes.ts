/**
 * The live PayPal calls behind the approval gate (design 4.4, REQ-DIS-09).
 *
 *   submit_evidence  POST /v1/customer/disputes/{id}/provide-evidence
 *   accept_claim     POST /v1/customer/disputes/{id}/accept-claim
 *
 * Both carry the stored PayPal-Request-Id, so repeating a call after a lost response is safe on
 * PayPal's side. This module is only reached through submitEvidence / acceptClaim, which run
 * requireApproval() first; it is deliberately NOT exported from the PayPal index.
 */
import { z } from "zod";
import type { PayPalClient } from "./client";
import type { PayPalDisputeWrite } from "./disputes";
import { DisputeWriteResponseSchema } from "./types";

export async function performLiveDisputeWrite(
  client: PayPalClient,
  paypalDisputeId: string,
  call: PayPalDisputeWrite,
  requestId: string,
): Promise<Record<string, unknown>> {
  const id = encodeURIComponent(paypalDisputeId);
  const path =
    call.kind === "submit_evidence" ? `/v1/customer/disputes/${id}/provide-evidence` : `/v1/customer/disputes/${id}/accept-claim`;
  const response = await client.request(path, { method: "POST", body: call.body, requestId }, DisputeWriteResponseSchema);
  return response as z.infer<typeof DisputeWriteResponseSchema>;
}
