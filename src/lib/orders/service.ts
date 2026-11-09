/**
 * Order flow (design 7.1): create a PayPal sandbox order, capture it when the buyer returns, then
 * ingest and score it.
 *
 *   createSandboxOrder   POST /api/orders              -> status "created" + PayPal approval URL
 *   handlePayPalReturn   GET  /api/orders/paypal-return -> capture, store capture id, score
 *   handlePayPalCancel   GET  /api/orders/paypal-cancel -> status "cancelled"
 *
 * All I/O is injected (OrderDeps), so every rule here is tested offline. Every step is reported
 * to the agent-activity log through `deps.log`; summaries hold ids, amounts and signal names only.
 */
import { randomUUID } from "node:crypto";
import type { NewOrder, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
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
// Activity logging
// ---------------------------------------------------------------------------

type Step = Pick<ActivityMeta, "stepType" | "toolName" | "inputSummary" | "outputSummary" | "status">;

/**
 * Report one step. `refOrderId` must be an order that already exists (agent_activity has a foreign
 * key to it), so callers log after the insert. A failing logger never changes the outcome.
 */
async function record(
  deps: OrderDeps,
  where: { sessionId: string | null; refOrderId: string },
  step: Step,
  startedAt: number,
): Promise<void> {
  try {
    await deps.log?.({ ...where, ...step, durationMs: Date.now() - startedAt });
  } catch {
    /* logging is best effort */
  }
}

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

  const started = Date.now();
  const where = { sessionId, refOrderId: order.id };
  const [baselineAvgUsd, weights] = await Promise.all([deps.repo.getBaselineAvgUsd(), deps.repo.getActiveWeights()]);
  if (!Number.isFinite(baselineAvgUsd) || baselineAvgUsd <= 0) {
    throw new Error("settings.merchant_avg_order_value_usd must be a positive number");
  }

  const signals = evaluateSignals(order, weights.values, baselineAvgUsd);
  const riskScore = computeRiskScore(signals);
  const verdict = toVerdict(riskScore);
  let scored = await deps.repo.updateOrder(order.id, {
    riskScore,
    verdict,
    signalBreakdown: signals,
    weightsId: weights.id,
  });
  const active = signals.filter((s) => s.active).map((s) => s.signal);
  await record(
    deps,
    where,
    {
      stepType: "rule_engine",
      toolName: "score_order",
      inputSummary: `amount=${order.amountUsd} ${order.currency} shipping=${order.shippingMethod} ${order.billingCountry}->${order.shippingCountry} attempts=${order.paymentAttemptCount}`,
      outputSummary: `score ${riskScore} -> ${verdict}; active signals: ${active.length > 0 ? active.join(", ") : "none"}`,
      status: "success",
    },
    started,
  );

  if (!deps.ai) return scored;
  const ai = deps.ai;
  const ctx = { sessionId };
  const aiStarted = Date.now();

  // The explanation (any score above 0) and the verification draft ("Verify first" only) do not
  // depend on each other, so they run together, and one failing never discards the other.
  const [explanation, draft] = await Promise.allSettled([
    riskScore >= 1 ? ai.explainRisk(scored, ctx) : Promise.resolve(null),
    verdict === "verify" ? ai.draftVerification(scored, ctx) : Promise.resolve(null),
  ]);

  const patch: Partial<NewOrder> = {};
  let usedFallback = false;
  if (explanation.status === "fulfilled" && explanation.value) {
    patch.aiExplanation = explanation.value.text;
    usedFallback ||= explanation.value.usedFallback;
  }
  if (draft.status === "fulfilled" && draft.value) {
    patch.verificationDraft = draft.value.draft;
    usedFallback ||= draft.value.usedFallback;
  }
  // One flag covers both steps: if either was replaced by rule-based text, say so.
  if (Object.keys(patch).length > 0) {
    try {
      scored = await deps.repo.updateOrder(order.id, { ...patch, usedFallback });
    } catch {
      // The score is already saved; the AI text is lost this time.
      await recordEnrichmentFailure(deps, where, riskScore, verdict, "could not save the AI text", aiStarted);
      return scored;
    }
  }
  if (explanation.status === "rejected" || draft.status === "rejected") {
    // Static text only: a hook's error message is not logged. The score is already saved.
    await recordEnrichmentFailure(deps, where, riskScore, verdict, "an AI step failed unexpectedly; the order keeps its rule-based score", aiStarted);
  }
  return scored;
}

async function recordEnrichmentFailure(
  deps: OrderDeps,
  where: { sessionId: string | null; refOrderId: string },
  riskScore: number,
  verdict: string,
  outputSummary: string,
  startedAt: number,
): Promise<void> {
  await record(
    deps,
    where,
    { stepType: "llm_call", toolName: "order_ai_enrichment", inputSummary: `order scored ${riskScore} -> ${verdict}`, outputSummary, status: "error" },
    startedAt,
  );
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
  const started = Date.now();
  const where = { sessionId, refOrderId: id };
  const inputSummary = `create sandbox order amount=${input.amountUsd} USD shipping=${input.shippingMethod} ${input.billingCountry}->${input.shippingCountry}`;

  let fallbackMessage: string | undefined;
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
    {
      demoMode: deps.demoMode,
      onFallback: ({ message }) => {
        fallbackMessage = message;
      },
    },
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
    await record(
      deps,
      where,
      { stepType: "paypal_api", toolName: "create_order", inputSummary, outputSummary: "PayPal order created; waiting for the buyer to approve", status: "success" },
      started,
    );
    return { kind: "paypal", orderId: id, approvalUrl: live.data.approvalUrl };
  }

  // PayPal was not used (Demo Mode, no credentials, or the sandbox failed): keep the demo moving
  // with a clearly marked demo order that is already "paid" and scored like any other.
  const reason = live.reason ?? "paypal_error";
  const demo = await deps.repo.insertOrder({
    ...shared,
    paypalOrderId: null,
    buyerEmail: DEMO_BUYER_EMAIL,
    buyerIsFirstTime: true, // fixed, so the first-time signals can be demonstrated every time
    status: "captured",
    isDemo: true,
  });
  await record(
    deps,
    where,
    {
      stepType: "paypal_api",
      toolName: "create_order",
      inputSummary,
      outputSummary: `Demo Mode (${reason})${fallbackMessage ? `: ${fallbackMessage}` : ""}; created a demo order instead of a PayPal order`,
      status: "simulated",
    },
    started,
  );
  await ingestAndScore(demo, sessionId, deps);
  return { kind: "demo", orderId: id, reason };
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

  const started = Date.now();
  const where = { sessionId, refOrderId: order.id };
  const failed = async (message: string): Promise<ReturnOutcome> => {
    await record(
      deps,
      where,
      { stepType: "paypal_api", toolName: "capture_order", inputSummary: "capture after buyer approval", outputSummary: message, status: "error" },
      started,
    );
    return { kind: "capture_failed", orderId: order.id, message };
  };

  if (!deps.paypal) return failed("PayPal credentials are not configured");

  let captured;
  try {
    // Same request id on every attempt for this order, so PayPal itself will not capture twice.
    captured = await captureOrder(deps.paypal, paypalOrderId, `capture-${order.id}`);
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    return failed(err.message);
  }
  if (captured.status !== "COMPLETED") return failed(`PayPal order status is ${captured.status}, not COMPLETED`);

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
  await record(
    deps,
    where,
    {
      stepType: "paypal_api",
      toolName: "capture_order",
      inputSummary: "capture after buyer approval",
      outputSummary: `COMPLETED; capture id stored; payer email ${captured.payerEmail ? "received" : "not provided"}; ${buyerIsFirstTime ? "first-time" : "returning"} buyer`,
      status: "success",
    },
    started,
  );
  return finish(updated, sessionId, deps);
}

/** Score a paid order if it is not scored yet. A scoring failure is reported, not thrown. */
async function finish(order: Order, sessionId: string, deps: OrderDeps): Promise<ReturnOutcome> {
  const started = Date.now();
  try {
    await ingestAndScore(order, sessionId, deps);
    return { kind: "ok", orderId: order.id, scored: true };
  } catch {
    // Static text only: a database error message can echo row values.
    await record(
      deps,
      { sessionId, refOrderId: order.id },
      {
        stepType: "rule_engine",
        toolName: "score_order",
        inputSummary: "score after capture",
        outputSummary: "scoring failed; the order is captured but not scored",
        status: "error",
      },
      started,
    );
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
  const started = Date.now();
  const updated = await deps.repo.transitionStatus(order.id, "created", { status: "cancelled" });
  if (!updated) return { kind: "not_cancellable", orderId: order.id };
  await record(
    deps,
    { sessionId, refOrderId: order.id },
    { stepType: "merchant_action", toolName: "cancel_order", inputSummary: "buyer cancelled at PayPal", outputSummary: "order marked cancelled", status: "success" },
    started,
  );
  return { kind: "cancelled", orderId: order.id };
}
