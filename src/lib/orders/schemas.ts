import { z } from "zod";
import { SHIPPING_METHODS } from "@/db/schema";

const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "must be a 2-letter country code")
  .transform((v) => v.toUpperCase());

/**
 * Body of POST /api/orders (the "New sandbox order" form). Everything here is merchant-typed, so it
 * is validated at the boundary. Unknown keys are rejected. The buyer's email is not a field: it
 * arrives from PayPal when the payment is captured.
 */
export const CreateOrderRequestSchema = z
  .object({
    itemName: z.string().trim().min(1, "is required").max(127, "must be at most 127 characters"),
    amountUsd: z
      .number({ invalid_type_error: "must be a number" })
      .finite()
      .min(0.01, "must be at least 0.01")
      .max(10_000, "must be at most 10000")
      .transform((v) => Math.round(v * 100) / 100),
    shippingMethod: z.enum(SHIPPING_METHODS),
    billingCountry: country,
    shippingCountry: country,
    /** How many payment attempts the buyer made. The form defaults it to 1. */
    paymentAttemptCount: z.number().int().min(1).max(10).default(1),
  })
  .strict();

export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

/** PayPal order ids are short alphanumeric strings; reject anything else before it touches a query. */
export const PayPalTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid token");
