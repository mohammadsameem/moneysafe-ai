import { describe, expect, it } from "vitest";
import { CreateOrderRequestSchema, PayPalTokenSchema } from "../schemas";
import { toSignalWeightValues } from "../weights";
import { DEFAULT_SIGNAL_WEIGHTS } from "@/lib/scoring";
import type { SignalWeights } from "@/db/schema";

const valid = {
  itemName: "Handmade mug",
  amountUsd: 40,
  shippingMethod: "standard",
  billingCountry: "us",
  shippingCountry: " in ",
};

describe("CreateOrderRequestSchema", () => {
  it("accepts a valid body, upper-cases countries and defaults attempts to 1", () => {
    const parsed = CreateOrderRequestSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, billingCountry: "US", shippingCountry: "IN", paymentAttemptCount: 1 });
  });

  it("rounds the amount to cents", () => {
    expect(CreateOrderRequestSchema.parse({ ...valid, amountUsd: 19.999 }).amountUsd).toBe(20);
    expect(CreateOrderRequestSchema.parse({ ...valid, amountUsd: 0.1 + 0.2 }).amountUsd).toBe(0.3);
  });

  it.each([
    ["zero amount", { amountUsd: 0 }],
    ["negative amount", { amountUsd: -5 }],
    ["amount below one cent", { amountUsd: 0.004 }],
    ["amount over the cap", { amountUsd: 10_000.01 }],
    ["amount as a string", { amountUsd: "40" }],
    ["NaN amount", { amountUsd: Number.NaN }],
    ["Infinity amount", { amountUsd: Number.POSITIVE_INFINITY }],
    ["empty item name", { itemName: "   " }],
    ["item name over 127 characters", { itemName: "x".repeat(128) }],
    ["unknown shipping method", { shippingMethod: "drone" }],
    ["3-letter country", { billingCountry: "USA" }],
    ["numeric country", { shippingCountry: "12" }],
    ["zero attempts", { paymentAttemptCount: 0 }],
    ["fractional attempts", { paymentAttemptCount: 1.5 }],
    ["too many attempts", { paymentAttemptCount: 11 }],
    ["an unknown key (the buyer email is not accepted)", { buyerEmail: "x@y.com" }],
  ])("rejects %s", (_name, patch) => {
    expect(CreateOrderRequestSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("PayPalTokenSchema", () => {
  it("accepts PayPal-style order ids", () => {
    expect(PayPalTokenSchema.safeParse("5O190127TN364715T").success).toBe(true);
  });

  it.each(["", "a b", "x/../y", "a'; DROP TABLE orders;--", "x".repeat(65)])("rejects %j", (token) => {
    expect(PayPalTokenSchema.safeParse(token).success).toBe(false);
  });
});

describe("toSignalWeightValues", () => {
  it("maps the camelCase database row to the scoring engine's snake_case weights", () => {
    const row = {
      id: "w",
      countryMismatch: 1,
      firstTimeHighValue: 2,
      rushShipping: 3,
      highRelativeValue: 4,
      disposableEmail: 5,
      repeatedAttempts: 6,
    } as SignalWeights;

    expect(toSignalWeightValues(row)).toEqual({
      country_mismatch: 1,
      first_time_high_value: 2,
      rush_shipping: 3,
      high_relative_value: 4,
      disposable_email: 5,
      repeated_attempts: 6,
    });
  });

  it("covers exactly the signals the engine has weights for", () => {
    const keys = Object.keys(toSignalWeightValues({} as SignalWeights)).sort();
    expect(keys).toEqual(Object.keys(DEFAULT_SIGNAL_WEIGHTS).sort());
  });
});
