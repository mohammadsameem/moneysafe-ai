import type { NewOrder, Order, VerificationDraft } from "@/db/schema";
import type { DemoFallbackOptions, PayPalClient } from "@/lib/paypal";
import type { SignalWeightValues } from "@/lib/scoring";

export type OrderStatus = Order["status"];

/** The database operations the order flow needs. Implemented with Drizzle in `repo.ts`; faked in tests. */
export interface OrdersRepo {
  /** `settings.merchant_avg_order_value_usd`. */
  getBaselineAvgUsd(): Promise<number>;
  /** The active `signal_weights` row, already mapped to the scoring engine's snake_case values. */
  getActiveWeights(): Promise<{ id: string; values: SignalWeightValues }>;
  /** True when another order from this buyer was already paid (captured or shipped). */
  hasEarlierPaidOrder(email: string, excludeOrderId: string): Promise<boolean>;
  insertOrder(row: NewOrder): Promise<Order>;
  findById(id: string): Promise<Order | null>;
  findByPayPalOrderId(paypalOrderId: string): Promise<Order | null>;
  /** Unconditional update; throws if the order does not exist. */
  updateOrder(id: string, patch: Partial<NewOrder>): Promise<Order>;
  /**
   * Update only while the order is still in status `from`. Returns null when it is not (another
   * request got there first), so two concurrent returns cannot both process the same order.
   */
  transitionStatus(id: string, from: OrderStatus, patch: Partial<NewOrder>): Promise<Order | null>;
}

export interface AiCallContext {
  sessionId: string | null;
}

/**
 * The two AI steps of the order flow. They are optional: with no hooks the order is scored by the
 * rule engine only and the AI columns stay empty. M1-09 supplies real hooks built on
 * `callWithFallback`, which never throws because of the model and returns the rule-based text
 * (with `usedFallback: true`) when the model is unavailable.
 */
export interface OrderAiHooks {
  explainRisk(order: Order, ctx: AiCallContext): Promise<{ text: string; usedFallback: boolean }>;
  draftVerification(order: Order, ctx: AiCallContext): Promise<{ draft: VerificationDraft; usedFallback: boolean }>;
}

export interface OrderDeps {
  repo: OrdersRepo;
  /** Null when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. */
  paypal: PayPalClient | null;
  demoMode: boolean;
  /** The app's public origin, e.g. https://moneysafe.example. Used for PayPal return/cancel URLs. */
  appBaseUrl: string;
  ai?: OrderAiHooks;
  /** Called when order creation falls back to a demo order. Bind to the activity logger. */
  onFallback?: DemoFallbackOptions["onFallback"];
  /** Called with a short, secret-free message when a non-fatal step fails. */
  onWarning?: (message: string) => void;
  newId?: () => string;
}
