import { describe, expect, it } from "vitest";
import type { Order } from "@/db/schema";
import { makeOrder } from "@/lib/orders/__tests__/fakes";
import { createFakePayPal } from "@/lib/orders/__tests__/fakes";
import { PayPalError } from "@/lib/paypal";
import { ingestPayPalDisputes, localDisputeId, type IngestDeps, type IngestRepo, type NewDisputeRow } from "../ingest";
import { NOW, OTHER_SESSION, SESSION } from "./fakes";

const CAPTURE = "6PS66781KE216001F"; // seller-side id on the real sandbox dispute
const BUYER_TXN = "4TA61915V29844255";
const PP = "PP-R-PIN-10197984";
const LIST = "GET /v1/customer/disputes?page_size=50";

const detail = (over: Record<string, unknown> = {}) => ({
  dispute_id: PP,
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_state: "REQUIRED_ACTION",
  dispute_life_cycle_stage: "INQUIRY",
  dispute_amount: { currency_code: "USD", value: "230.00" },
  seller_response_due_date: "2026-11-30T09:43:35.378Z",
  disputed_transactions: [{ seller_transaction_id: CAPTURE, buyer_transaction_id: BUYER_TXN }],
  messages: [{ posted_by: "BUYER", content: "the product is not delivered" }],
  allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] } },
  ...over,
});
const listItem = (over: Record<string, unknown> = {}) => ({ dispute_id: PP, status: "WAITING_FOR_SELLER_RESPONSE", ...over });

const realOrder = (over: Partial<Order> = {}) => makeOrder({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sessionId: SESSION, isSeed: false, isDemo: false, paypalCaptureId: CAPTURE, amountUsd: 230, status: "captured", ...over });

function setup(orders: Order[], existing: Array<{ id: string; paypalDisputeId: string; sessionId: string | null }> = [], over: Partial<IngestDeps> = {}) {
  const inserted: NewDisputeRow[] = [];
  const repo: IngestRepo = {
    findOwnRealOrderByCapture: async (sessionId, captureId) => orders.find((o) => o.sessionId === sessionId && !o.isSeed && !o.isDemo && o.paypalCaptureId === captureId) ?? null,
    findDisputeByPaypalId: async (id) => existing.find((d) => d.paypalDisputeId === id) ?? null,
    insertDispute: async (v) => {
      if (inserted.some((d) => d.id === v.id) || existing.some((d) => d.id === v.id)) return false;
      inserted.push(v);
      return true;
    },
  };
  const paypal = createFakePayPal({ [LIST]: { items: [listItem()] }, [`GET /v1/customer/disputes/${PP}`]: detail() });
  const logs: unknown[] = [];
  const deps: IngestDeps = { repo, paypal, demoMode: false, now: () => NOW, log: async (m) => void logs.push(m), ...over };
  return { deps, inserted, paypal, logs };
}

describe("ingestPayPalDisputes", () => {
  it("links the dispute whose transaction is the capture of the caller's own real order", async () => {
    const { deps, inserted } = setup([realOrder()]);
    const result = await ingestPayPalDisputes(SESSION, deps);

    expect(result).toMatchObject({ kind: "ok", checked: 1, linked: [{ paypalDisputeId: PP, created: true }] });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      id: localDisputeId(PP),
      paypalDisputeId: PP,
      orderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      reason: "item_not_received",
      disputedAmountUsd: 230,
      deadlineAt: "2026-11-30T09:43:35.378Z",
      status: "open",
      sessionId: SESSION,
      isSeed: false,
      isDemo: false,
      analysisComputedAt: null, // the normal analysis runs when the dispute is opened
    });
    expect(inserted[0]!.buyerMessage).toBe("PayPal reason: MERCHANDISE_OR_SERVICE_NOT_RECEIVED\nBuyer wrote: the product is not delivered");
  });

  it("is idempotent: a second run creates nothing and reports the same dispute", async () => {
    const first = setup([realOrder()]);
    await ingestPayPalDisputes(SESSION, first.deps);
    const again = setup([realOrder()], [{ id: localDisputeId(PP), paypalDisputeId: PP, sessionId: SESSION }]);
    const result = await ingestPayPalDisputes(SESSION, again.deps);
    expect(result).toMatchObject({ kind: "ok", linked: [{ disputeId: localDisputeId(PP), created: false }] });
    expect(again.inserted).toHaveLength(0);
  });

  it("does not match another session's order (no dispute, nothing created)", async () => {
    const { deps, inserted } = setup([realOrder({ sessionId: OTHER_SESSION })]);
    const result = await ingestPayPalDisputes(SESSION, deps);
    expect(result).toMatchObject({ kind: "ok", linked: [], skipped: { unmatched: 1 } });
    expect(inserted).toHaveLength(0);
  });

  it("does not match a demo or seeded order, even with the same capture id", async () => {
    for (const order of [realOrder({ isDemo: true }), realOrder({ isSeed: true })]) {
      const { deps, inserted } = setup([order]);
      expect(await ingestPayPalDisputes(SESSION, deps)).toMatchObject({ linked: [], skipped: { unmatched: 1 } });
      expect(inserted).toHaveLength(0);
    }
  });

  it("leaves a dispute that another session already linked alone, and does not report it", async () => {
    const { deps, inserted } = setup([realOrder()], [{ id: localDisputeId(PP), paypalDisputeId: PP, sessionId: OTHER_SESSION }]);
    const result = await ingestPayPalDisputes(SESSION, deps);
    expect(result).toMatchObject({ kind: "ok", linked: [], skipped: { otherSession: 1 } });
    expect(inserted).toHaveLength(0);
  });

  it("skips a resolved dispute without reading it", async () => {
    const { deps } = setup([realOrder()], [], { paypal: createFakePayPal({ [LIST]: { items: [listItem({ status: "RESOLVED" })] } }) });
    expect(await ingestPayPalDisputes(SESSION, deps)).toMatchObject({ kind: "ok", checked: 0, linked: [], skipped: { resolved: 1 } });
  });

  it("only handles USD", async () => {
    const { deps, inserted } = setup([realOrder()], [], {
      paypal: createFakePayPal({ [LIST]: { items: [listItem()] }, [`GET /v1/customer/disputes/${PP}`]: detail({ dispute_amount: { currency_code: "EUR", value: "230.00" } }) }),
    });
    expect(await ingestPayPalDisputes(SESSION, deps)).toMatchObject({ linked: [], skipped: { unsupported: 1 } });
    expect(inserted).toHaveLength(0);
  });

  it("a reason the app does not model is mapped, and the stored text says so", async () => {
    const { deps, inserted } = setup([realOrder()], [], {
      paypal: createFakePayPal({ [LIST]: { items: [listItem()] }, [`GET /v1/customer/disputes/${PP}`]: detail({ reason: "UNAUTHORISED" }) }),
    });
    await ingestPayPalDisputes(SESSION, deps);
    expect(inserted[0]).toMatchObject({ reason: "item_not_received" });
    expect(inserted[0]!.buyerMessage).toContain("PayPal reason: UNAUTHORISED");
    expect(inserted[0]!.buyerMessage).toContain('analyses it as "item not received"');
  });

  it("falls back to a 20-day deadline when PayPal gives no response-due date", async () => {
    const { deps, inserted } = setup([realOrder()], [], {
      paypal: createFakePayPal({ [LIST]: { items: [listItem()] }, [`GET /v1/customer/disputes/${PP}`]: detail({ seller_response_due_date: undefined }) }),
    });
    await ingestPayPalDisputes(SESSION, deps);
    expect(inserted[0]!.deadlineAt).toBe(new Date(NOW.getTime() + 20 * 24 * 3600 * 1000).toISOString());
  });

  it("never contacts PayPal in Demo Mode or without credentials, and says why", async () => {
    const demo = setup([realOrder()], [], { demoMode: true });
    expect(await ingestPayPalDisputes(SESSION, demo.deps)).toMatchObject({ kind: "unavailable", message: expect.stringContaining("Demo Mode") });
    expect(demo.paypal.request).not.toHaveBeenCalled();
    expect(await ingestPayPalDisputes(SESSION, setup([realOrder()], [], { paypal: null }).deps)).toMatchObject({ kind: "unavailable", message: expect.stringContaining("credentials") });
  });

  it("reports PayPal being down without creating anything", async () => {
    const { deps, inserted } = setup([realOrder()], [], { paypal: createFakePayPal({ [LIST]: new PayPalError("down", 503) }) });
    expect(await ingestPayPalDisputes(SESSION, deps)).toMatchObject({ kind: "unavailable", message: expect.stringContaining("could not be reached") });
    expect(inserted).toHaveLength(0);
  });

  it("counts a dispute it could not read and carries on", async () => {
    const { deps } = setup([realOrder()], [], { paypal: createFakePayPal({ [LIST]: { items: [listItem()] }, [`GET /v1/customer/disputes/${PP}`]: new PayPalError("boom", 500) }) });
    expect(await ingestPayPalDisputes(SESSION, deps)).toMatchObject({ kind: "ok", linked: [], skipped: { failed: 1 } });
  });

  it("a sync records PayPal's closure on a dispute this session already linked: resolved, no approval/execution/outcome", async () => {
    const calls: Array<{ id: string; status: string; outcome: string | null; note: string }> = [];
    const resolution = {
      markResolvedOnPayPal: async (i: { id: string; status: string; outcome: string | null; note: string }) => {
        calls.push(i);
        return {} as never;
      },
    };
    const closedDetail = detail({ status: "RESOLVED", dispute_state: "RESOLVED", dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR", outcome_reason: "SELLER_ISSUED_REFUND" } });
    const { deps, inserted } = setup([realOrder()], [{ id: localDisputeId(PP), paypalDisputeId: PP, sessionId: SESSION }], {
      resolution,
      paypal: createFakePayPal({ [LIST]: { items: [listItem({ status: "RESOLVED" })] }, [`GET /v1/customer/disputes/${PP}`]: closedDetail }),
    });
    const result = await ingestPayPalDisputes(SESSION, deps);
    expect(result).toMatchObject({ kind: "ok", closedOnPayPal: 1, linked: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: localDisputeId(PP), status: "resolved_refunded", outcome: "refunded" });
    expect(calls[0]!.note).toContain("buyer's favour");
    expect(inserted).toHaveLength(0);
  });

  it("a sync never closes a dispute that belongs to another session, or one it never linked", async () => {
    for (const existing of [[{ id: localDisputeId(PP), paypalDisputeId: PP, sessionId: OTHER_SESSION }], []]) {
      let touched = 0;
      const { deps } = setup([realOrder()], existing, {
        resolution: { markResolvedOnPayPal: async () => (touched++, null) },
        paypal: createFakePayPal({ [LIST]: { items: [listItem({ status: "RESOLVED" })] } }),
      });
      expect(await ingestPayPalDisputes(SESSION, deps)).toMatchObject({ kind: "ok", closedOnPayPal: 0 });
      expect(touched).toBe(0);
    }
  });

  it("only reads: it never POSTs to PayPal", async () => {
    const { deps, paypal } = setup([realOrder()]);
    await ingestPayPalDisputes(SESSION, deps);
    for (const call of paypal.request.mock.calls) expect((call[1] as { method: string }).method).toBe("GET");
  });
});
