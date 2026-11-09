import { describe, expect, it } from "vitest";
import type { EvidenceArtefact, NewEvidenceArtefact, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import type { EvidenceRepo } from "@/lib/evidence/assembler";
import { PayPalError } from "@/lib/paypal";
import { appendCommunication, CommunicationRequestSchema } from "../evidence-service";
import { isLiveOrder, shipOrder, type ShipDeps, type ShipmentRepo } from "../ship";
import { createFakePayPal, makeOrder } from "./fakes";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const SESSION = "session-a";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TRACK_PATH = `POST /v2/checkout/orders/PAYPAL-ORDER-1/track`;
const GET_PATH = `GET /v2/checkout/orders/PAYPAL-ORDER-1`;
const PAYPAL_ORDER = {
  id: "PAYPAL-ORDER-1",
  status: "COMPLETED",
  purchase_units: [{ amount: { currency_code: "USD", value: "120.00" }, items: [{ name: "Throw blanket", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }] }],
  payer: { email_address: "buyer@example.com" },
};

/** In-memory shipment + evidence store with the SQL semantics (conditional status move, append-only rows). */
function store(initial: Order[]) {
  const orders = new Map(initial.map((o) => [o.id, o]));
  const artefacts: EvidenceArtefact[] = [];
  const repo: ShipmentRepo = {
    findVisibleOrder: async (id, sessionId) => {
      const o = orders.get(id);
      return o && (o.isSeed || o.sessionId === sessionId) ? o : null;
    },
    completeShipment: async (id, rows, completeness) => {
      const o = orders.get(id);
      if (!o || o.status !== "captured") return false;
      orders.set(id, { ...o, status: "shipped", evidenceCompleteness: completeness });
      artefacts.push(...(rows as EvidenceArtefact[]));
      return true;
    },
  };
  const evidence: EvidenceRepo = {
    insertArtefacts: async (rows: NewEvidenceArtefact[]) => {
      artefacts.push(...(rows as EvidenceArtefact[]));
      return rows as EvidenceArtefact[];
    },
    getEvidenceByOrderId: async (id) => artefacts.filter((a) => a.orderId === id),
  };
  return { orders, artefacts, repo, evidence };
}

const liveOrder = (over: Partial<Order> = {}) =>
  makeOrder({ id: ORDER_ID, status: "captured", paypalOrderId: "PAYPAL-ORDER-1", paypalCaptureId: "CAPTURE-1", buyerEmail: "buyer@example.com", amountUsd: 120, ...over });
const demoOrder = (over: Partial<Order> = {}) => liveOrder({ isDemo: true, paypalOrderId: null, paypalCaptureId: null, ...over });

function deps(s: ReturnType<typeof store>, over: Partial<ShipDeps> = {}): ShipDeps & { logs: ActivityMeta[] } {
  const logs: ActivityMeta[] = [];
  return { repo: s.repo, paypal: null, demoMode: false, now: () => NOW, log: async (m) => void logs.push(m), ...over, logs };
}
const ship = (d: ShipDeps, over: Partial<{ trackingNumber: string; carrier: string; sessionId: string; orderId: string }> = {}) =>
  shipOrder({ orderId: ORDER_ID, sessionId: SESSION, trackingNumber: "9400111899223197428490", carrier: "USPS", ...over }, d);

describe("shipOrder: a demo order (no PayPal)", () => {
  it("records the evidence without calling PayPal, logs the add-tracking step as simulated, moves the order to shipped", async () => {
    const s = store([demoOrder()]);
    const paypal = createFakePayPal({});
    const d = deps(s, { paypal });

    const out = await ship(d);

    expect(out).toEqual({ kind: "shipped", completeness: 60, artefacts: 4, warnings: [], paypalTracking: "skipped" });
    expect(paypal.request).not.toHaveBeenCalled();
    expect(s.orders.get(ORDER_ID)).toMatchObject({ status: "shipped", evidenceCompleteness: 60 });
    expect(s.artefacts.map((a) => a.artefactType)).toEqual(["invoice_summary", "buyer_contact", "tracking_info", "tracking_events"]);
    expect(s.artefacts.find((a) => a.artefactType === "tracking_events")).toMatchObject({ isMocked: true, source: "mocked" });
    expect(d.logs.map((l) => `${l.toolName}:${l.status}`)).toEqual(["add_tracking:simulated", "assemble_evidence:success"]);
  });
});

describe("shipOrder: a live PayPal order", () => {
  it("sends add-tracking with the capture id, carrier and notify_payer false, reads the order, records 5 artefacts", async () => {
    const s = store([liveOrder()]);
    const paypal = createFakePayPal({ [TRACK_PATH]: { id: "PAYPAL-ORDER-1" }, [GET_PATH]: PAYPAL_ORDER });
    const d = deps(s, { paypal });

    const out = await ship(d, { carrier: "UPS", trackingNumber: "1Z999AA10123456784" });

    expect(out).toMatchObject({ kind: "shipped", paypalTracking: "sent", warnings: [], artefacts: 5, completeness: 75 });
    const trackCall = paypal.request.mock.calls.find((c) => String(c[0]).endsWith("/track"))!;
    expect(trackCall[1]).toMatchObject({
      method: "POST",
      requestId: `track-${ORDER_ID}`,
      body: { capture_id: "CAPTURE-1", tracking_number: "1Z999AA10123456784", carrier: "UPS", notify_payer: false },
    });
    expect(s.artefacts.find((a) => a.artefactType === "line_items")?.payload).toMatchObject({ items: [{ name: "Throw blanket" }] });
    expect(d.logs.map((l) => `${l.toolName}:${l.status}`)).toEqual(["add_tracking:success", "get_order:success", "assemble_evidence:success"]);
  });

  it("an add-tracking failure is a non-blocking warning: the order still ships with its evidence", async () => {
    const s = store([liveOrder()]);
    const paypal = createFakePayPal({ [TRACK_PATH]: new PayPalError("PayPal POST track failed with HTTP 422 (INVALID_CARRIER)", 422), [GET_PATH]: PAYPAL_ORDER });
    const d = deps(s, { paypal });

    const out = await ship(d);

    expect(out).toMatchObject({ kind: "shipped", paypalTracking: "failed" });
    expect(out.kind === "shipped" && out.warnings[0]).toContain("INVALID_CARRIER");
    expect(s.orders.get(ORDER_ID)?.status).toBe("shipped");
    expect(d.logs[0]).toMatchObject({ toolName: "add_tracking", status: "error" });
  });

  it("when PayPal cannot be read, the evidence falls back to the stored order (no line items) and a Demo Mode event is logged", async () => {
    const s = store([liveOrder()]);
    const paypal = createFakePayPal({ [TRACK_PATH]: { id: "PAYPAL-ORDER-1" }, [GET_PATH]: new PayPalError("PayPal could not be reached") });
    const d = deps(s, { paypal });

    const out = await ship(d);

    expect(out).toMatchObject({ kind: "shipped", artefacts: 4 });
    expect(s.artefacts.map((a) => a.artefactType)).not.toContain("line_items");
    expect(d.logs.find((l) => l.toolName === "get_order")).toMatchObject({ status: "simulated" });
  });

  it("an order with no capture id ships, with a warning, and PayPal is not called for tracking", async () => {
    const s = store([liveOrder({ paypalCaptureId: null })]);
    const paypal = createFakePayPal({ [GET_PATH]: PAYPAL_ORDER });
    const out = await ship(deps(s, { paypal }));
    expect(out).toMatchObject({ kind: "shipped", paypalTracking: "skipped" });
    expect(out.kind === "shipped" && out.warnings[0]).toContain("no PayPal capture id");
    expect(paypal.request.mock.calls.some((c) => String(c[0]).endsWith("/track"))).toBe(false);
  });

  it("DEMO_MODE skips add-tracking and the PayPal read even for a real order", async () => {
    const s = store([liveOrder()]);
    const paypal = createFakePayPal({});
    const out = await ship(deps(s, { paypal, demoMode: true }));
    expect(out).toMatchObject({ kind: "shipped", paypalTracking: "skipped" });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("a bug is not disguised as a PayPal warning", async () => {
    const s = store([liveOrder()]);
    const paypal = createFakePayPal({ [TRACK_PATH]: new TypeError("bug") });
    await expect(ship(deps(s, { paypal }))).rejects.toThrow("bug");
    expect(s.orders.get(ORDER_ID)?.status).toBe("captured");
    expect(s.artefacts).toHaveLength(0);
  });
});

describe("shipOrder: refusals write nothing", () => {
  it("seeded orders are shared examples", async () => {
    const s = store([demoOrder({ isSeed: true, sessionId: null })]);
    expect(await ship(deps(s))).toEqual({ kind: "shared_example" });
    expect(s.artefacts).toHaveLength(0);
  });

  it("another session's order, or an unknown one, is not found", async () => {
    const s = store([demoOrder({ sessionId: "session-b" })]);
    expect(await ship(deps(s))).toEqual({ kind: "not_found" });
    expect(await ship(deps(s), { orderId: "nope" })).toEqual({ kind: "not_found" });
  });

  it("only a captured order can ship", async () => {
    for (const status of ["created", "cancelled", "shipped"] as const) {
      const s = store([demoOrder({ status })]);
      expect(await ship(deps(s))).toEqual({ kind: "not_shippable", status });
      expect(s.artefacts).toHaveLength(0);
    }
  });

  it("shipping twice (a double click) writes the evidence once", async () => {
    const s = store([demoOrder()]);
    const [a, b] = await Promise.all([ship(deps(s)), ship(deps(s))]);
    expect([a.kind, b.kind].sort()).toEqual(["not_shippable", "shipped"]);
    expect(s.artefacts).toHaveLength(4);
  });
});

describe("isLiveOrder", () => {
  it("is true only for a non-seed, non-demo PayPal order outside Demo Mode", () => {
    expect(isLiveOrder(liveOrder(), false)).toBe(true);
    expect(isLiveOrder(liveOrder(), true)).toBe(false);
    expect(isLiveOrder(liveOrder({ isDemo: true }), false)).toBe(false);
    expect(isLiveOrder(liveOrder({ isSeed: true }), false)).toBe(false);
    expect(isLiveOrder(liveOrder({ paypalOrderId: null }), false)).toBe(false);
  });
});

describe("appendCommunication", () => {
  const evDeps = (s: ReturnType<typeof store>) => {
    const scores = new Map<string, number>();
    return {
      deps: { findVisibleOrder: s.repo.findVisibleOrder, evidence: s.evidence, setCompleteness: async (id: string, c: number) => void scores.set(id, c), now: () => NOW },
      scores,
    };
  };
  const msg = { direction: "inbound" as const, subject: "Re: your order", body: "It arrived, thanks!" };

  it("appends a buyer communication to a shipped order and raises the score by 10", async () => {
    const s = store([demoOrder()]);
    await ship(deps(s));
    const { deps: d, scores } = evDeps(s);

    const out = await appendCommunication(ORDER_ID, SESSION, msg, d);

    expect(out).toEqual({ kind: "appended", completeness: 70 });
    expect(scores.get(ORDER_ID)).toBe(70);
    expect(s.artefacts.at(-1)).toMatchObject({ artefactType: "buyer_communication", payload: { direction: "inbound", subject: "Re: your order", body: "It arrived, thanks!" } });
    const before = s.artefacts.slice(0, -1).map((a) => JSON.stringify(a));
    await appendCommunication(ORDER_ID, SESSION, { ...msg, body: "Second" }, d);
    expect(s.artefacts.slice(0, before.length).map((a) => JSON.stringify(a))).toEqual(before); // nothing existing changed
  });

  it("is refused for seeds, other sessions, unshipped orders and future dates", async () => {
    expect(await appendCommunication(ORDER_ID, SESSION, msg, evDeps(store([demoOrder({ isSeed: true, status: "shipped" })])).deps)).toEqual({ kind: "shared_example" });
    expect(await appendCommunication(ORDER_ID, SESSION, msg, evDeps(store([demoOrder({ sessionId: "session-b", status: "shipped" })])).deps)).toEqual({ kind: "not_found" });
    expect(await appendCommunication(ORDER_ID, SESSION, msg, evDeps(store([demoOrder()])).deps)).toEqual({ kind: "not_shipped" });
    const future = { ...msg, sentAt: new Date(NOW.getTime() + 3_600_000).toISOString() };
    expect(await appendCommunication(ORDER_ID, SESSION, future, evDeps(store([demoOrder({ status: "shipped" })])).deps)).toMatchObject({ kind: "invalid" });
  });

  it("the request schema bounds every field and rejects unknown ones", () => {
    expect(CommunicationRequestSchema.safeParse(msg).success).toBe(true);
    for (const bad of [{ ...msg, direction: "sideways" }, { ...msg, subject: "" }, { ...msg, body: "x".repeat(2001) }, { ...msg, subject: "x".repeat(151) }, { ...msg, extra: 1 }, { ...msg, sentAt: "yesterday" }]) {
      expect(CommunicationRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});
