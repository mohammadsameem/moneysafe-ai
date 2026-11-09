import { describe, expect, it, vi } from "vitest";
import { PayPalError } from "@/lib/paypal";
import {
  DEMO_BUYER_EMAIL,
  PENDING_BUYER_EMAIL,
  createSandboxOrder,
  handlePayPalCancel,
  handlePayPalReturn,
  ingestAndScore,
} from "../service";
import type { CreateOrderRequest } from "../schemas";
import type { OrderAiHooks } from "../types";
import {
  createLogRecorder,
  BASE_URL,
  CREATE_RESPONSE,
  OTHER_SESSION,
  SESSION,
  WEIGHTS_ID,
  captureResponse,
  createFakePayPal,
  createFakeRepo,
  makeDeps,
  makeOrder,
} from "./fakes";

const ORDER_ID = "22222222-2222-4222-8222-222222222222";

const input = (overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest => ({
  itemName: "Handmade mug",
  amountUsd: 40,
  shippingMethod: "standard",
  billingCountry: "US",
  shippingCountry: "US",
  paymentAttemptCount: 1,
  ...overrides,
});

describe("createSandboxOrder", () => {
  it("creates the PayPal order with return and cancel URLs and stores a 'created' order for the session", async () => {
    const paypal = createFakePayPal({ "POST /v2/checkout/orders": CREATE_RESPONSE });
    const repo = createFakeRepo();

    const outcome = await createSandboxOrder(input({ amountUsd: 120.5 }), SESSION, makeDeps({ repo, paypal }));

    expect(outcome).toEqual({
      kind: "paypal",
      orderId: ORDER_ID,
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1",
    });

    type CreateBody = {
      intent: string;
      payment_source: { paypal: { experience_context: { return_url: string; cancel_url: string } } };
    };
    const [path, init] = paypal.request.mock.calls[0] as [string, { body: CreateBody; requestId?: string }];
    expect(path).toBe("/v2/checkout/orders");
    expect(init.body.intent).toBe("CAPTURE");
    const ctx = init.body.payment_source.paypal.experience_context;
    expect(ctx.return_url).toBe(`${BASE_URL}/api/orders/paypal-return`);
    expect(ctx.cancel_url).toBe(`${BASE_URL}/api/orders/paypal-cancel`);
    expect(init.requestId).toBe(ORDER_ID); // retrying creation cannot make a second PayPal order

    const row = repo.rows.get(ORDER_ID);
    expect(row).toMatchObject({
      status: "created",
      paypalOrderId: "PAYPAL-ORDER-1",
      sessionId: SESSION,
      buyerEmail: PENDING_BUYER_EMAIL,
      amountUsd: 120.5,
      isDemo: false,
      isSeed: false,
      riskScore: null, // scored only after capture
    });
  });

  it("creates a scored, clearly marked demo order when there are no PayPal credentials", async () => {
    const repo = createFakeRepo();
    const { log, entries } = createLogRecorder(repo);

    const outcome = await createSandboxOrder(
      input({ amountUsd: 300, billingCountry: "US", shippingCountry: "IN" }),
      SESSION,
      makeDeps({ repo, paypal: null, log }),
    );

    expect(outcome).toEqual({ kind: "demo", orderId: ORDER_ID, reason: "no_credentials" });
    expect(entries.map((e) => `${e.toolName}:${e.status}`)).toEqual(["create_order:simulated", "score_order:success"]);
    expect(entries[0]?.outputSummary).toContain("Demo Mode (no_credentials)");
    const row = repo.rows.get(ORDER_ID);
    expect(row).toMatchObject({
      isDemo: true,
      status: "captured",
      paypalOrderId: null,
      buyerEmail: DEMO_BUYER_EMAIL,
      sessionId: SESSION,
      weightsId: WEIGHTS_ID,
    });
    // country_mismatch 20 + first_time_high_value 20 + high_relative_value 20 (300 > 3 x 85)
    expect(row?.riskScore).toBe(60);
    expect(row?.verdict).toBe("verify");
  });

  it("uses a demo order and never calls PayPal in DEMO_MODE", async () => {
    const paypal = createFakePayPal({});
    const repo = createFakeRepo();

    const outcome = await createSandboxOrder(input(), SESSION, makeDeps({ repo, paypal, demoMode: true }));

    expect(outcome).toMatchObject({ kind: "demo", reason: "demo_mode" });
    expect(paypal.request).not.toHaveBeenCalled();
    expect(repo.rows.get(ORDER_ID)?.isDemo).toBe(true);
  });

  it("falls back to a demo order when the sandbox is unreachable, and reports why", async () => {
    const paypal = createFakePayPal({ "POST /v2/checkout/orders": new PayPalError("PayPal could not be reached") });
    const repo = createFakeRepo();
    const { log, entries } = createLogRecorder(repo);

    const outcome = await createSandboxOrder(input(), SESSION, makeDeps({ repo, paypal, log }));

    expect(outcome).toEqual({ kind: "demo", orderId: ORDER_ID, reason: "paypal_error" });
    expect(entries[0]).toMatchObject({ toolName: "create_order", status: "simulated" });
    expect(entries[0]?.outputSummary).toContain("PayPal could not be reached");
    expect(repo.rows.get(ORDER_ID)).toMatchObject({ isDemo: true, paypalOrderId: null });
  });

  it("does not hide a bug behind a demo order: a non-PayPal error is rethrown and nothing is stored", async () => {
    const paypal = createFakePayPal({ "POST /v2/checkout/orders": new TypeError("boom") });
    const repo = createFakeRepo();

    await expect(createSandboxOrder(input(), SESSION, makeDeps({ repo, paypal }))).rejects.toThrow("boom");
    expect(repo.rows.size).toBe(0);
  });
});

describe("handlePayPalReturn", () => {
  const created = (overrides = {}) => makeOrder({ id: ORDER_ID, amountUsd: 300, ...overrides });

  it("captures, stores the capture id and payer email, scores with the settings baseline and active weights", async () => {
    const repo = createFakeRepo([created()]);
    const paypal = createFakePayPal({ "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": captureResponse() });

    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal }));

    expect(outcome).toEqual({ kind: "ok", orderId: ORDER_ID, scored: true });
    const [, init] = paypal.request.mock.calls[0] as [string, { requestId?: string }];
    expect(init.requestId).toBe(`capture-${ORDER_ID}`);

    const row = repo.rows.get(ORDER_ID);
    expect(row).toMatchObject({
      status: "captured",
      paypalCaptureId: "CAPTURE-1",
      buyerEmail: "buyer@example.com",
      buyerIsFirstTime: true,
      weightsId: WEIGHTS_ID,
    });
    // first_time_high_value 20 + high_relative_value 20 (300 > 3 x 85) = 40 -> verify
    expect(row?.riskScore).toBe(40);
    expect(row?.verdict).toBe("verify");
    expect(row?.signalBreakdown).toHaveLength(6);
    expect(row?.signalBreakdown?.filter((s) => s.active).map((s) => s.signal)).toEqual([
      "first_time_high_value",
      "high_relative_value",
    ]);
  });

  it("derives first-time from earlier paid orders of the same buyer, ignoring unpaid ones", async () => {
    const paidBefore = makeOrder({ id: "33333333-3333-4333-8333-333333333333", paypalOrderId: null, buyerEmail: "Buyer@Example.com", status: "captured" });
    const repo = createFakeRepo([paidBefore, created()]);
    const paypal = createFakePayPal({ "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": captureResponse() });

    await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal }));

    const row = repo.rows.get(ORDER_ID);
    expect(row?.buyerIsFirstTime).toBe(false);
    expect(row?.riskScore).toBe(20); // only high_relative_value
  });

  it("keeps the placeholder email when PayPal gives none, and still scores", async () => {
    const repo = createFakeRepo([created()]);
    const paypal = createFakePayPal({ "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": captureResponse({ email: null }) });

    await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal }));

    expect(repo.rows.get(ORDER_ID)).toMatchObject({ buyerEmail: PENDING_BUYER_EMAIL, status: "captured" });
    expect(repo.rows.get(ORDER_ID)?.riskScore).not.toBeNull();
  });

  it("refuses to capture an order that belongs to another session", async () => {
    const repo = createFakeRepo([created()]);
    const paypal = createFakePayPal({});

    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", OTHER_SESSION, makeDeps({ repo, paypal }));

    expect(outcome).toEqual({ kind: "not_found" });
    expect(paypal.request).not.toHaveBeenCalled();
    expect(repo.rows.get(ORDER_ID)?.status).toBe("created");
  });

  it("answers an unknown token exactly like another session's order", async () => {
    const outcome = await handlePayPalReturn("NO-SUCH-ORDER", SESSION, makeDeps({ repo: createFakeRepo([created()]) }));
    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("does not capture twice when the return URL is opened again", async () => {
    const repo = createFakeRepo([created()]);
    const paypal = createFakePayPal({ "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": captureResponse() });
    const deps = makeDeps({ repo, paypal });

    await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, deps);
    const again = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, deps);

    expect(again).toEqual({ kind: "ok", orderId: ORDER_ID, scored: true });
    expect(paypal.request).toHaveBeenCalledTimes(1);
  });

  it("scores a captured-but-unscored order when the return URL is opened again", async () => {
    const repo = createFakeRepo([created({ status: "captured", paypalCaptureId: "CAPTURE-1", buyerEmail: "buyer@example.com" })]);
    const paypal = createFakePayPal({});

    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal }));

    expect(outcome).toEqual({ kind: "ok", orderId: ORDER_ID, scored: true });
    expect(paypal.request).not.toHaveBeenCalled();
    expect(repo.rows.get(ORDER_ID)?.riskScore).not.toBeNull();
  });

  it("does not capture a cancelled order", async () => {
    const paypal = createFakePayPal({});
    const outcome = await handlePayPalReturn(
      "PAYPAL-ORDER-1",
      SESSION,
      makeDeps({ repo: createFakeRepo([created({ status: "cancelled" })]), paypal }),
    );
    expect(outcome).toEqual({ kind: "cancelled", orderId: ORDER_ID });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("leaves the order 'created' when PayPal refuses the capture, and returns the safe message", async () => {
    const repo = createFakeRepo([created()]);
    const paypal = createFakePayPal({
      "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": new PayPalError("PayPal POST capture failed with HTTP 422 (ORDER_NOT_APPROVED)", 422),
    });

    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal }));

    expect(outcome).toEqual({
      kind: "capture_failed",
      orderId: ORDER_ID,
      message: "PayPal POST capture failed with HTTP 422 (ORDER_NOT_APPROVED)",
    });
    expect(repo.rows.get(ORDER_ID)).toMatchObject({ status: "created", paypalCaptureId: null, riskScore: null });
  });

  it("does not treat a capture that is not COMPLETED as paid", async () => {
    const repo = createFakeRepo([created()]);
    const paypal = createFakePayPal({ "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": captureResponse({ status: "PAYER_ACTION_REQUIRED" }) });

    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal }));

    expect(outcome.kind).toBe("capture_failed");
    expect(repo.rows.get(ORDER_ID)?.status).toBe("created");
  });

  it("reports capture_failed when credentials have since been removed", async () => {
    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo: createFakeRepo([created()]), paypal: null }));
    expect(outcome.kind).toBe("capture_failed");
  });

  it("when a concurrent request captured the order first, it leaves that request's result alone and does not score again", async () => {
    const repo = createFakeRepo([created()]);
    repo.loseNextTransition();
    const paypal = createFakePayPal({ "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": captureResponse() });

    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal }));

    expect(outcome).toEqual({ kind: "ok", orderId: ORDER_ID, scored: true });
    expect(repo.rows.get(ORDER_ID)?.paypalCaptureId).toBe("CAPTURE-FROM-OTHER-REQUEST");
    expect(repo.rows.get(ORDER_ID)?.riskScore).toBeNull(); // the other request does the scoring
  });

  it("keeps the captured order and reports scored:false when scoring fails", async () => {
    const repo = createFakeRepo([created()]);
    repo.failWeightsLookup();
    const paypal = createFakePayPal({ "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture": captureResponse() });
    const { log, entries } = createLogRecorder(repo);

    const outcome = await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal, log }));

    expect(outcome).toEqual({ kind: "ok", orderId: ORDER_ID, scored: false });
    expect(entries.map((e) => `${e.toolName}:${e.status}`)).toEqual(["capture_order:success", "score_order:error"]);
    expect(JSON.stringify(entries)).not.toContain("connection lost"); // the database error text is never logged
    expect(repo.rows.get(ORDER_ID)).toMatchObject({ status: "captured", riskScore: null });
  });
});

describe("handlePayPalCancel", () => {
  it("marks an unpaid order cancelled", async () => {
    const repo = createFakeRepo([makeOrder({ id: ORDER_ID })]);
    const outcome = await handlePayPalCancel("PAYPAL-ORDER-1", SESSION, makeDeps({ repo }));
    expect(outcome).toEqual({ kind: "cancelled", orderId: ORDER_ID });
    expect(repo.rows.get(ORDER_ID)?.status).toBe("cancelled");
  });

  it("is idempotent", async () => {
    const repo = createFakeRepo([makeOrder({ id: ORDER_ID, status: "cancelled" })]);
    expect(await handlePayPalCancel("PAYPAL-ORDER-1", SESSION, makeDeps({ repo }))).toEqual({ kind: "cancelled", orderId: ORDER_ID });
  });

  it("does not cancel another session's order", async () => {
    const repo = createFakeRepo([makeOrder({ id: ORDER_ID })]);
    expect(await handlePayPalCancel("PAYPAL-ORDER-1", OTHER_SESSION, makeDeps({ repo }))).toEqual({ kind: "not_found" });
    expect(repo.rows.get(ORDER_ID)?.status).toBe("created");
  });

  it("leaves an order that is already paid alone", async () => {
    const repo = createFakeRepo([makeOrder({ id: ORDER_ID, status: "captured" })]);
    expect(await handlePayPalCancel("PAYPAL-ORDER-1", SESSION, makeDeps({ repo }))).toEqual({ kind: "not_cancellable", orderId: ORDER_ID });
    expect(repo.rows.get(ORDER_ID)?.status).toBe("captured");
  });
});

describe("ingestAndScore", () => {
  const paid = (overrides = {}) => makeOrder({ id: ORDER_ID, status: "captured", buyerEmail: "buyer@example.com", ...overrides });

  it("is idempotent: an already scored order is returned unchanged and nothing is read", async () => {
    const repo = createFakeRepo([]);
    const spy = vi.spyOn(repo, "getActiveWeights");
    const scored = paid({ riskScore: 55, verdict: "verify" });

    expect(await ingestAndScore(scored, SESSION, makeDeps({ repo }))).toBe(scored);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a non-positive baseline instead of scoring against it", async () => {
    const repo = createFakeRepo([paid()], 0);
    await expect(ingestAndScore(paid(), SESSION, makeDeps({ repo }))).rejects.toThrow(/positive/);
    expect(repo.rows.get(ORDER_ID)?.riskScore).toBeNull();
  });

  describe("with AI hooks", () => {
    const hooks = (overrides: Partial<OrderAiHooks> = {}): OrderAiHooks => ({
      explainRisk: vi.fn(async () => ({ text: "Because of the signals.", usedFallback: false })),
      draftVerification: vi.fn(async () => ({ draft: { subject: "Quick check", body: "Is this you?" }, usedFallback: false })),
      ...overrides,
    });

    it("adds the explanation, and the verification draft for a verify verdict", async () => {
      const ai = hooks();
      const repo = createFakeRepo([paid({ amountUsd: 300 })]); // 40 -> verify

      await ingestAndScore(paid({ amountUsd: 300 }), SESSION, makeDeps({ repo, ai }));

      expect(repo.rows.get(ORDER_ID)).toMatchObject({
        riskScore: 40,
        verdict: "verify",
        aiExplanation: "Because of the signals.",
        verificationDraft: { subject: "Quick check", body: "Is this you?" },
        usedFallback: false,
      });
      expect(ai.explainRisk).toHaveBeenCalledWith(expect.objectContaining({ riskScore: 40 }), { sessionId: SESSION });
    });

    it("skips both AI steps for a score of 0", async () => {
      const ai = hooks();
      const repo = createFakeRepo([paid()]);

      await ingestAndScore(paid(), SESSION, makeDeps({ repo, ai }));

      expect(repo.rows.get(ORDER_ID)?.riskScore).toBe(0);
      expect(ai.explainRisk).not.toHaveBeenCalled();
      expect(ai.draftVerification).not.toHaveBeenCalled();
    });

    it("explains a 'ship' order with a score above 0 but drafts no verification message", async () => {
      const ai = hooks();
      const repo = createFakeRepo([paid({ shippingMethod: "rush" })]); // 15 -> ship

      await ingestAndScore(paid({ shippingMethod: "rush" }), SESSION, makeDeps({ repo, ai }));

      expect(repo.rows.get(ORDER_ID)).toMatchObject({ riskScore: 15, verdict: "ship", aiExplanation: "Because of the signals." });
      expect(ai.draftVerification).not.toHaveBeenCalled();
    });

    it("sets usedFallback when either AI step fell back to rule-based text", async () => {
      const ai = hooks({
        draftVerification: vi.fn(async () => ({ draft: { subject: "Template", body: "Static" }, usedFallback: true })),
      });
      const repo = createFakeRepo([paid({ amountUsd: 300 })]);

      await ingestAndScore(paid({ amountUsd: 300 }), SESSION, makeDeps({ repo, ai }));

      expect(repo.rows.get(ORDER_ID)).toMatchObject({ aiExplanation: "Because of the signals.", usedFallback: true });
    });

    it("runs the explanation and the verification draft together, not one after the other", async () => {
      let releaseExplanation: () => void = () => undefined;
      const explanationGate = new Promise<void>((resolve) => {
        releaseExplanation = resolve;
      });
      const draftStarted = vi.fn(() => releaseExplanation()); // the explanation can only finish once the draft has started
      const ai = hooks({
        explainRisk: vi.fn(async () => {
          await explanationGate;
          return { text: "Explained.", usedFallback: false };
        }),
        draftVerification: vi.fn(async () => {
          draftStarted();
          return { draft: { subject: "S", body: "B" }, usedFallback: false };
        }),
      });
      const repo = createFakeRepo([paid({ amountUsd: 300 })]);

      await ingestAndScore(paid({ amountUsd: 300 }), SESSION, makeDeps({ repo, ai }));

      expect(repo.rows.get(ORDER_ID)).toMatchObject({ aiExplanation: "Explained.", verificationDraft: { subject: "S", body: "B" } });
    });

    it("keeps the other AI result when one step fails", async () => {
      const ai = hooks({ explainRisk: vi.fn(async () => { throw new Error("hook bug"); }) });
      const repo = createFakeRepo([paid({ amountUsd: 300 })]);

      await ingestAndScore(paid({ amountUsd: 300 }), SESSION, makeDeps({ repo, ai }));

      expect(repo.rows.get(ORDER_ID)).toMatchObject({ aiExplanation: null, verificationDraft: { subject: "Quick check", body: "Is this you?" } });
    });

    it("keeps the saved score when an AI hook throws", async () => {
      const ai = hooks({ explainRisk: vi.fn(async () => { throw new Error("hook bug"); }) });
      const repo = createFakeRepo([paid({ amountUsd: 300 })]);
      const { log, entries } = createLogRecorder(repo);

      const result = await ingestAndScore(paid({ amountUsd: 300 }), SESSION, makeDeps({ repo, ai, log }));

      expect(result).toMatchObject({ riskScore: 40, aiExplanation: null });
      expect(repo.rows.get(ORDER_ID)?.riskScore).toBe(40);
      expect(entries.map((e) => `${e.stepType}:${e.toolName}:${e.status}`)).toEqual([
        "rule_engine:score_order:success",
        "llm_call:order_ai_enrichment:error",
      ]);
      expect(JSON.stringify(entries)).not.toContain("hook bug");
    });
  });

  it("leaves the AI columns untouched when no hooks are bound", async () => {
    const repo = createFakeRepo([paid({ amountUsd: 300 })]);
    await ingestAndScore(paid({ amountUsd: 300 }), SESSION, makeDeps({ repo }));
    expect(repo.rows.get(ORDER_ID)).toMatchObject({ riskScore: 40, aiExplanation: null, verificationDraft: null, usedFallback: false });
  });
});

describe("agent activity log", () => {
  const unpaid = (overrides = {}) => makeOrder({ id: ORDER_ID, amountUsd: 300, ...overrides });
  const captureKey = "POST /v2/checkout/orders/PAYPAL-ORDER-1/capture";

  it("logs a live create as one paypal_api step for the new order and session, without the item name or approval URL", async () => {
    const repo = createFakeRepo();
    const { log, entries } = createLogRecorder(repo);
    const paypal = createFakePayPal({ "POST /v2/checkout/orders": CREATE_RESPONSE });

    await createSandboxOrder(input({ itemName: "Secret Gizmo" }), SESSION, makeDeps({ repo, paypal, log }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      stepType: "paypal_api",
      toolName: "create_order",
      status: "success",
      refOrderId: ORDER_ID,
      sessionId: SESSION,
    });
    const text = JSON.stringify(entries);
    expect(text).not.toContain("Secret Gizmo");
    expect(text).not.toContain("checkoutnow");
  });

  it("logs capture then scoring, and never writes the payer's email", async () => {
    const repo = createFakeRepo([unpaid()]);
    const { log, entries } = createLogRecorder(repo);
    const paypal = createFakePayPal({ [captureKey]: captureResponse({ email: "buyer@example.com" }) });

    await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal, log }));

    expect(entries.map((e) => `${e.stepType}:${e.toolName}:${e.status}`)).toEqual([
      "paypal_api:capture_order:success",
      "rule_engine:score_order:success",
    ]);
    expect(entries[1]?.outputSummary).toBe("score 40 -> verify; active signals: first_time_high_value, high_relative_value");
    expect(JSON.stringify(entries)).not.toContain("buyer@example.com");
  });

  it("logs a refused capture as an error with PayPal's safe message", async () => {
    const repo = createFakeRepo([unpaid()]);
    const { log, entries } = createLogRecorder(repo);
    const paypal = createFakePayPal({ [captureKey]: new PayPalError("PayPal POST capture failed with HTTP 422 (ORDER_NOT_APPROVED)", 422) });

    await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal, log }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: "capture_order", status: "error", refOrderId: ORDER_ID });
    expect(entries[0]?.outputSummary).toBe("PayPal POST capture failed with HTTP 422 (ORDER_NOT_APPROVED)");
  });

  it("logs a capture that is not COMPLETED as an error", async () => {
    const repo = createFakeRepo([unpaid()]);
    const { log, entries } = createLogRecorder(repo);
    const paypal = createFakePayPal({ [captureKey]: captureResponse({ status: "PAYER_ACTION_REQUIRED" }) });

    await handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo, paypal, log }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: "capture_order", status: "error" });
  });

  it("logs a cancel as a merchant_action, and logs nothing when nothing changed", async () => {
    const repo = createFakeRepo([unpaid()]);
    const { log, entries } = createLogRecorder(repo);
    const deps = makeDeps({ repo, log });

    await handlePayPalCancel("PAYPAL-ORDER-1", OTHER_SESSION, deps); // not this session's order
    expect(entries).toHaveLength(0);

    await handlePayPalCancel("PAYPAL-ORDER-1", SESSION, deps);
    expect(entries.map((e) => `${e.stepType}:${e.toolName}:${e.status}`)).toEqual(["merchant_action:cancel_order:success"]);

    await handlePayPalCancel("PAYPAL-ORDER-1", SESSION, deps); // repeat is a no-op
    expect(entries).toHaveLength(1);
  });

  it("logs nothing for a return that finds no order of the caller's", async () => {
    const repo = createFakeRepo([unpaid()]);
    const { log, entries } = createLogRecorder(repo);
    await handlePayPalReturn("PAYPAL-ORDER-1", OTHER_SESSION, makeDeps({ repo, log }));
    expect(entries).toHaveLength(0);
  });

  it("a logger that throws changes no outcome", async () => {
    const failing = async () => {
      throw new Error("log table is down");
    };

    const createRepo = createFakeRepo();
    const paypalCreate = createFakePayPal({ "POST /v2/checkout/orders": CREATE_RESPONSE });
    await expect(createSandboxOrder(input(), SESSION, makeDeps({ repo: createRepo, paypal: paypalCreate, log: failing }))).resolves.toMatchObject({ kind: "paypal" });

    const returnRepo = createFakeRepo([unpaid()]);
    const paypalCapture = createFakePayPal({ [captureKey]: captureResponse() });
    await expect(handlePayPalReturn("PAYPAL-ORDER-1", SESSION, makeDeps({ repo: returnRepo, paypal: paypalCapture, log: failing }))).resolves.toEqual({ kind: "ok", orderId: ORDER_ID, scored: true });
    expect(returnRepo.rows.get(ORDER_ID)).toMatchObject({ status: "captured", riskScore: 40 });

    const cancelRepo = createFakeRepo([unpaid()]);
    await expect(handlePayPalCancel("PAYPAL-ORDER-1", SESSION, makeDeps({ repo: cancelRepo, log: failing }))).resolves.toEqual({ kind: "cancelled", orderId: ORDER_ID });
  });
});
