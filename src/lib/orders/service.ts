/**
 * Order flow (design 7.1): create a PayPal sandbox order, capture it when the buyer returns, then
 * ingest and score it.
 *
 *   createSandboxOrder   POST /api/orders              -> status "created" + PayPal approval URL
 *   handlePayPalReturn   GET  /api/orders/paypal-return -> capture, store capture id, score
 *   handlePayPalCancel   GET  /api/orders/paypal-cancel -> status "cancelled"
 *
 * All I/O is injected (OrderDeps), so every rule here is tested offline.
 */
import { randomUUID } from "node:crypto";
import type { NewOrder, Order } from "@/db/schema";
import {
  captureOrder,
  createOrder,
  PayPalError,
  withDemoFallback,
  type CreatedOrder,
  type DemoReason,
} from "@/lib/paypal";
import { computeRiskScore, evaluateSignals, toVerdict } from "@/lib/scoring";
import type { CreateOrderRequest } from "./schemas";
import type { OrderDeps } from "./types";

/** Stored until PayPal tells us the payer's email at capture (the column is NOT NULL). `.invalid` is a reserved TLD. */
export const PENDING_BUYER_EMAIL = "pending@paypal.invalid";
/** Buyer used for demo orders created when the sandbox is unavailable. */
export const DEMO_BUYER_EMAIL = "demo.buyer@example.com";

export const PAYPAL_RETURN_PATH = "/api/orders/paypal-return";
export const PAYPAL_CANCEL_PATH = "/api/orders/paypal-cancel";

// ---------------------------------------------------------------------------
// Ingest + score
// ---------------------------------------------------------------------------

/**
 * Score a paid order and, if AI hooks are present, add the explanation and the verification draft.
 * Idempotent: an order that already has a risk score is returned unchanged, so retrying after a
 * failure never scores twice. The rule-based score is saved before any AI step runs.
 */
export async function ingestAndScore(order: Order, sessionId: string | null, deps: OrderDeps): Promise<Order> {
  if (order.riskScore !== null) return order;

  const [baselineAvgUsd, weights] = await Promise.all([deps.repo.getBaselineAvgUsd(), deps.repo.getActiveWeights()]);
  if (!Number.isFinite(baselineAvgUsd) || baselineAvgUsd <= 0) {
    throw new Error("settings.merchant_avg_order_value_usd must be a positive number");
  }

  const signals = evaluateSignals(order, weights.values, baselineAvgUsd);
  const riskScore = computeRiskScore(signals);
  let scored = await deps.repo.updateOrder(order.id, {
    riskScore,
    verdict: toVerdict(riskScore),
    signalBreakdown: signals,
    weightsId: weights.id,
  });

  if (!deps.ai) return scored;
  const ctx = { sessionId };
  const patch: Partial<NewOrder> = {};
  try {
    if (scored.riskScore !== null && scored.riskScore >= 1) {
      const explanation = await deps.ai.explainRisk(scored, ctx);
      patch.aiExplanation = explanation.text;
      patch.usedFallback = explanation.usedFallback;
    }
    if (scored.verdict === "verify") {
      const draft = await deps.ai.draftVerification(scored, ctx);
      patch.verificationDraft = draft.draft;
      // One flag covers both AI steps: if either was replaced by rule-based text, say so.
      patch.usedFallback = (patch.usedFallback ?? false) || draft.usedFallback;
    }
    if (Object.keys(patch).length > 0) scored = await deps.repo.updateOrder(order.id, patch);
  } catch {
    // The score is already saved. A failing AI step must never undo or block the order.
    deps.onWarning?.("AI enrichment failed; the order keeps its rule-based score");
  }
  return scored;
}

// ---------------------------------------------------------------------------
// 1. Create
// ---------------------------------------------------------------------------

export type CreateOrderOutcome =
  | { kind: "paypal"; orderId: string; approvalUrl: string }
  /** No PayPal order was made; a scored demo order was created instead. */
  | { kind: "demo"; orderId: string; reason: DemoReason };

export async function createSandboxOrder(
  input: CreateOrderRequest,
  sessionId: string,
  deps: OrderDeps,
): Promise<CreateOrderOutcome> {
  const id = deps.newId?.() ?? randomUUID();
  const paypal = deps.paypal;

  const live = await withDemoFallback<CreatedOrder | null>(
    paypal
      ? () =>
          createOrder(paypal, {
            amountUsd: input.amountUsd,
            itemName: input.itemName,
            returnUrl: `${deps.appBaseUrl}${PAYPAL_RETURN_PATH}`,
            cancelUrl: `${deps.appBaseUrl}${PAYPAL_CANCEL_PATH}`,
            requestId: id,
          })
      : null,
    () => null,
    { demoMode: deps.demoMode, onFallback: deps.onFallback },
  );

  const shared = {
    id,
    shippingMethod: input.shippingMethod,
    billingCountry: input.billingCountry,
    shippingCountry: input.shippingCountry,
    amountUsd: input.amountUsd,
    currency: "USD",
    paymentAttemptCount: input.paymentAttemptCount,
    sessionId,
    isSeed: false,
  } satisfies Partial<NewOrder>;

  if (!live.isDemo && live.data) {
    await deps.repo.insertOrder({
      ...shared,
      paypalOrderId: live.data.paypalOrderId,
      buyerEmail: PENDING_BUYER_EMAIL,
      buyerIsFirstTime: true, // recomputed from the payer's email at capture
      status: "created",
      isDemo: false,
    });
    return { kind: "paypal", orderId: id, approvalUrl: live.data.approvalUrl };
  }

  // PayPal was not used (Demo Mode, no credentials, or the sandbox failed): keep the demo moving
  // with a clearly marked demo order that is already "paid" and scored like any other.
  const demo = await deps.repo.insertOrder({
    ...shared,
    paypalOrderId: null,
    buyerEmail: DEMO_BUYER_EMAIL,
    buyerIsFirstTime: true, // fixed, so the first-time signals can be demonstrated every time
    status: "captured",
    isDemo: true,
  });
  await ingestAndScore(demo, sessionId, deps);
  return { kind: "demo", orderId: id, reason: live.reason ?? "paypal_error" };
}

// ---------------------------------------------------------------------------
// 2. Return from PayPal
// ---------------------------------------------------------------------------

export type ReturnOutcome =
  /** Paid. `scored` is false only when scoring was attempted in this request and failed (it can be retried). */
  | { kind: "ok"; orderId: string; scored: boolean }
  /** Unknown token, or the order belongs to another session. The two are not told apart. */
  | { kind: "not_found" }
  | { kind: "cancelled"; orderId: string }
  /** PayPal would not capture. The order stays "created". `message` carries no secrets. */
  | { kind: "capture_failed"; orderId: string; message: string };

export async function handlePayPalReturn(
  paypalOrderId: string,
  sessionId: string,
  deps: OrderDeps,
): Promise<ReturnOutcome> {
  const order = await deps.repo.findByPayPalOrderId(paypalOrderId);
  if (!order || order.sessionId !== sessionId) return { kind: "not_found" };
  if (order.status === "cancelled") return { kind: "cancelled", orderId: order.id };

  // Already captured (a page refresh, or a double click): do not capture again.
  if (order.status !== "created") return finish(order, sessionId, deps);

  if (!deps.paypal) {
    return { kind: "capture_failed", orderId: order.id, message: "PayPal credentials are not configured" };
  }

  let captured;
  try {
    // Same request id on every attempt for this order, so PayPal itself will not capture twice.
    captured = await captureOrder(deps.paypal, paypalOrderId, `capture-${order.id}`);
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    return { kind: "capture_failed", orderId: order.id, message: err.message };
  }
  if (captured.status !== "COMPLETED") {
    return { kind: "capture_failed", orderId: order.id, message: `PayPal order status is ${captured.status}, not COMPLETED` };
  }

  const buyerEmail = captured.payerEmail ?? order.buyerEmail;
  const buyerIsFirstTime = !(await deps.repo.hasEarlierPaidOrder(buyerEmail, order.id));
  const updated = await deps.repo.transitionStatus(order.id, "created", {
    status: "captured",
    paypalCaptureId: captured.captureId,
    buyerEmail,
    buyerIsFirstTime,
  });
  if (!updated) {
    // Another request captured it first and is scoring it. Do not score a second time (that would
    // spend a second LLM call); if that request dies, opening this URL again scores the order.
    const current = await deps.repo.findById(order.id);
    return current ? { kind: "ok", orderId: current.id, scored: true } : { kind: "not_found" };
  }
  return finish(updated, sessionId, deps);
}

/** Score a paid order if it is not scored yet. A scoring failure is reported, not thrown. */
async function finish(order: Order, sessionId: string, deps: OrderDeps): Promise<ReturnOutcome> {
  try {
    await ingestAndScore(order, sessionId, deps);
    return { kind: "ok", orderId: order.id, scored: true };
  } catch {
    deps.onWarning?.("scoring failed after capture; the order is captured but not scored");
    return { kind: "ok", orderId: order.id, scored: false };
  }
}

// ---------------------------------------------------------------------------
// 3. Cancel at PayPal
// ---------------------------------------------------------------------------

export type CancelOutcome = { kind: "cancelled"; orderId: string } | { kind: "not_found" } | { kind: "not_cancellable"; orderId: string };

export async function handlePayPalCancel(
  paypalOrderId: string,
  sessionId: string,
  deps: OrderDeps,
): Promise<CancelOutcome> {
  const order = await deps.repo.findByPayPalOrderId(paypalOrderId);
  if (!order || order.sessionId !== sessionId) return { kind: "not_found" };
  if (order.status === "cancelled") return { kind: "cancelled", orderId: order.id };
  // Only an order that has not been paid can be cancelled; a paid order is left alone.
  const updated = await deps.repo.transitionStatus(order.id, "created", { status: "cancelled" });
  return updated ? { kind: "cancelled", orderId: order.id } : { kind: "not_cancellable", orderId: order.id };
}
