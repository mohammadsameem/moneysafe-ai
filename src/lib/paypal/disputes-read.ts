/**
 * PayPal customer-disputes READ calls (design 4.3):
 *   listDisputes  GET /v1/customer/disputes
 *   getDispute    GET /v1/customer/disputes/{id}
 *
 * Reads only: nothing here changes a dispute. Wrap calls in withDemoFallback so a PayPal failure
 * falls back to the seeded or stored record (REQ-DEMO-01).
 */
import { z } from "zod";
import type { PayPalClient } from "./client";
import { ListDisputesResponseSchema, PayPalDisputeSchema } from "./types";

export type PayPalDispute = z.infer<typeof PayPalDisputeSchema>;

export interface ListDisputesOptions {
  /** Maximum items per page (PayPal allows 1-50). */
  pageSize?: number;
  /** PayPal dispute_state filter, e.g. "REQUIRED_ACTION". */
  disputeState?: string;
}

export async function listDisputes(client: PayPalClient, options: ListDisputesOptions = {}): Promise<PayPalDispute[]> {
  const query = new URLSearchParams();
  query.set("page_size", String(Math.min(50, Math.max(1, Math.trunc(options.pageSize ?? 20)))));
  if (options.disputeState) query.set("dispute_state", options.disputeState);
  const body = await client.request(`/v1/customer/disputes?${query.toString()}`, { method: "GET" }, ListDisputesResponseSchema);
  return body.items;
}

export async function getDispute(client: PayPalClient, paypalDisputeId: string): Promise<PayPalDispute> {
  return client.request(`/v1/customer/disputes/${encodeURIComponent(paypalDisputeId)}`, { method: "GET" }, PayPalDisputeSchema);
}
