/**
 * zod schemas for the PayPal REST responses this app reads. They validate only the fields we
 * use and ignore the rest, so PayPal adding fields never breaks us. Anything PayPal sends that
 * fails validation is an error, never silently trusted.
 */
import { z } from "zod";

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
});

export const Money = z.object({ currency_code: z.string(), value: z.string() });

export const LinkSchema = z.object({ href: z.string().url(), rel: z.string(), method: z.string().optional() });

export const CreateOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  links: z.array(LinkSchema).default([]),
});

const CaptureSchema = z.object({ id: z.string().min(1), status: z.string().optional() });

const PayerSchema = z
  .object({
    email_address: z.string().optional(),
    name: z.object({ given_name: z.string().optional(), surname: z.string().optional() }).optional(),
  })
  .optional();

export const CaptureOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  purchase_units: z
    .array(z.object({ payments: z.object({ captures: z.array(CaptureSchema).default([]) }).optional() }))
    .default([]),
  payer: PayerSchema,
});

export const GetOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  create_time: z.string().optional(),
  purchase_units: z
    .array(
      z.object({
        amount: Money.optional(),
        items: z
          .array(
            z.object({
              name: z.string(),
              quantity: z.string(),
              unit_amount: Money,
              category: z.string().optional(),
            }),
          )
          .optional(),
        payments: z.object({ captures: z.array(CaptureSchema).default([]) }).optional(),
      }),
    )
    .default([]),
  payer: PayerSchema,
});

/** Add-tracking responds with the order; we only confirm it names an order. */
export const AddTrackingResponseSchema = z.object({ id: z.string().min(1) });

export const PayPalErrorBodySchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Disputes (customer disputes API). Only the fields the app reads; PayPal adding fields is fine.
// ---------------------------------------------------------------------------
export const PayPalDisputeSchema = z.object({
  dispute_id: z.string().min(1),
  status: z.string(),
  reason: z.string().optional(),
  dispute_state: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_amount: Money.optional(),
  /** ISO-8601; when the seller must respond by. */
  seller_response_due_date: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});

export const ListDisputesResponseSchema = z.object({
  items: z.array(PayPalDisputeSchema).default([]),
});

/** Provide-evidence and accept-claim answer with the dispute (or a link list); we keep what is there. */
export const DisputeWriteResponseSchema = z.object({}).passthrough();
