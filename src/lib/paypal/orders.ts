/**
 * PayPal Orders v2 calls used by the app (sandbox):
 *   createOrder  POST /v2/checkout/orders            -> approval URL for the buyer
 *   captureOrder POST /v2/checkout/orders/{id}/capture -> capture id after the buyer approves
 *   getOrder     GET  /v2/checkout/orders/{id}       -> invoice / line items for the Evidence Vault
 *   addTracking  POST /v2/checkout/orders/{id}/track -> tell PayPal the shipment (seller protection)
 *
 * The app owns its own orders table: there is no "list orders" call (design 1).
 * All functions take the PayPalClient explicitly, so they are testable with a fake fetch.
 */
import { z } from "zod";
import type { PayPalClient } from "./client";
import { PayPalError } from "./errors";
import {
  AddTrackingResponseSchema,
  CaptureOrderResponseSchema,
  CreateOrderResponseSchema,
  GetOrderResponseSchema,
} from "./types";

export interface CreateOrderInput {
  /** Total in USD. Must equal the sum of the line items. */
  amountUsd: number;
  itemName: string;
  returnUrl: string;
  cancelUrl: string;
  /** Idempotency key for creation (PayPal-Request-Id). */
  requestId?: string;
}

export interface CreatedOrder {
  paypalOrderId: string;
  /** Where to send the buyer to approve the payment. */
  approvalUrl: string;
}

/** PayPal expects money as a decimal string with two places. */
export const toMoney = (amount: number): string => amount.toFixed(2);

export async function createOrder(client: PayPalClient, input: CreateOrderInput): Promise<CreatedOrder> {
  const value = toMoney(input.amountUsd);
  const order = await client.request(
    "/v2/checkout/orders",
    {
      method: "POST",
      requestId: input.requestId,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value, breakdown: { item_total: { currency_code: "USD", value } } },
            items: [
              {
                name: input.itemName.slice(0, 127),
                quantity: "1",
                unit_amount: { currency_code: "USD", value },
                category: "PHYSICAL_GOODS",
              },
            ],
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      },
    },
    CreateOrderResponseSchema,
  );

  // With payment_source the buyer link is "payer-action"; the older application_context flow uses "approve".
  const link = order.links.find((l) => l.rel === "payer-action") ?? order.links.find((l) => l.rel === "approve");
  if (!link) throw new PayPalError("PayPal created the order but returned no approval link");
  return { paypalOrderId: order.id, approvalUrl: link.href };
}

export interface CapturedOrder {
  paypalOrderId: string;
  status: string;
  /** purchase_units[0].payments.captures[0].id, required later by add-tracking. */
  captureId: string;
  payerEmail?: string;
  payerName?: string;
}

export async function captureOrder(client: PayPalClient, paypalOrderId: string, requestId?: string): Promise<CapturedOrder> {
  const order = await client.request(
    `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
    { method: "POST", requestId, body: {} },
    CaptureOrderResponseSchema,
  );
  const captureId = order.purchase_units[0]?.payments?.captures[0]?.id;
  if (!captureId) throw new PayPalError("PayPal captured the order but returned no capture id");
  const name = [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" ");
  return {
    paypalOrderId: order.id,
    status: order.status,
    captureId,
    ...(order.payer?.email_address ? { payerEmail: order.payer.email_address } : {}),
    ...(name ? { payerName: name } : {}),
  };
}

export type PayPalOrder = z.infer<typeof GetOrderResponseSchema>;

export async function getOrder(client: PayPalClient, paypalOrderId: string): Promise<PayPalOrder> {
  return client.request(
    `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
    { method: "GET" },
    GetOrderResponseSchema,
  );
}

export interface AddTrackingInput {
  captureId: string;
  trackingNumber: string;
  /** Our carrier code, e.g. "USPS", "UPS", "FEDEX". Anything else is sent as OTHER with its name. */
  carrier: string;
  notifyPayer?: boolean;
  requestId?: string;
}

/** Carriers PayPal accepts under the same code we use. Everything else is sent as OTHER. */
const PAYPAL_CARRIER_CODES: Readonly<Record<string, string>> = { USPS: "USPS", UPS: "UPS", FEDEX: "FEDEX" };

export async function addTracking(client: PayPalClient, paypalOrderId: string, input: AddTrackingInput): Promise<void> {
  const code = PAYPAL_CARRIER_CODES[input.carrier.toUpperCase()];
  await client.request(
    `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/track`,
    {
      method: "POST",
      requestId: input.requestId,
      body: {
        capture_id: input.captureId,
        tracking_number: input.trackingNumber,
        carrier: code ?? "OTHER",
        ...(code ? {} : { carrier_name_other: input.carrier }),
        notify_payer: input.notifyPayer ?? false,
      },
    },
    AddTrackingResponseSchema,
  );
}
