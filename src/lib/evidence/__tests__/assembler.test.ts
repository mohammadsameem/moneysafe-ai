import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { makeOrder } from "@/lib/orders/__tests__/fakes";
import type { PayPalOrder } from "@/lib/paypal";
import { computeEvidenceCompleteness } from "@/lib/scoring";
import { mockedEvents } from "@/lib/tracking/mocked";
import { buildCommunicationArtefact, buildShipmentArtefacts, summarizeEvidence } from "../assembler";

config({ path: ".env.local", quiet: true });

const NOW = new Date("2026-11-08T12:00:00.000Z");
const SHIPPED = new Date("2026-11-04T12:00:00.000Z");
const order = makeOrder({ id: "order-1", paypalOrderId: "PP-ORDER-1", buyerEmail: "buyer@example.com", amountUsd: 120, shippingCountry: "US", status: "captured" });
const paypalOrder: PayPalOrder = {
  id: "PP-ORDER-1",
  status: "COMPLETED",
  create_time: "2026-11-03T10:00:00Z",
  purchase_units: [
    {
      amount: { currency_code: "USD", value: "120.00" },
      items: [{ name: "Hand-knitted throw blanket", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" }, category: "PHYSICAL_GOODS" }],
      payments: { captures: [{ id: "CAP-1" }] },
    },
  ],
  payer: { email_address: "buyer@example.com", name: { given_name: "Jane", surname: "Buyer" } },
};
const shipment = { trackingNumber: "9400111899223197428490", carrier: "USPS", shippedAt: SHIPPED };
const delivered = { events: mockedEvents({ ...shipment, destination: "Columbus, OH" }, NOW), provider: "mocked", isMocked: true };
let n = 0;
const ids = () => `art-${++n}`;

describe("buildShipmentArtefacts", () => {
  it("with a PayPal order: invoice, line items, contact, tracking info and mocked scan events", () => {
    const rows = buildShipmentArtefacts({ order, paypalOrder, shipment, tracking: delivered, now: NOW, newId: ids });
    expect(rows.map((r) => r.artefactType)).toEqual(["invoice_summary", "line_items", "buyer_contact", "tracking_info", "tracking_events"]);
    const by = Object.fromEntries(rows.map((r) => [r.artefactType, r]));
    expect(by.invoice_summary).toMatchObject({ source: "paypal_api", payload: { orderId: "PP-ORDER-1", amount: 120, currency: "USD", status: "COMPLETED" } });
    expect(by.line_items).toMatchObject({ source: "paypal_api", payload: { items: [{ name: "Hand-knitted throw blanket", quantity: 1, unitAmount: 120 }] } });
    expect(by.buyer_contact).toMatchObject({ source: "paypal_api", payload: { email: "buyer@example.com", name: "Jane Buyer", country: "US" } });
    expect(by.tracking_info).toMatchObject({ source: "merchant_input", payload: { trackingNumber: shipment.trackingNumber, carrier: "USPS", shippedAt: SHIPPED.toISOString() } });
    expect(by.tracking_events).toMatchObject({ source: "mocked", isMocked: true });
    expect(rows.every((r) => r.orderId === "order-1" && r.createdAt === NOW.toISOString())).toBe(true);
    expect(computeEvidenceCompleteness(rows)).toBe(90); // everything but buyer communications
  });

  it("without PayPal (a demo order): invoice and contact from the local order, NO invented line items", () => {
    const rows = buildShipmentArtefacts({ order: { ...order, paypalOrderId: null }, paypalOrder: null, shipment, tracking: delivered, now: NOW, newId: ids });
    expect(rows.map((r) => r.artefactType)).toEqual(["invoice_summary", "buyer_contact", "tracking_info", "tracking_events"]);
    expect(rows[0]).toMatchObject({ source: "merchant_input", payload: { orderId: "order-1", amount: 120, status: "CAPTURED" } });
    expect(rows[1]).toMatchObject({ source: "merchant_input", payload: { email: "buyer@example.com" } });
    expect(computeEvidenceCompleteness(rows)).toBe(75);
  });

  it("a just-shipped parcel has scans but no Delivered event; no events at all means no tracking_events artefact", () => {
    const early = { events: mockedEvents({ ...shipment, destination: "X" }, new Date(SHIPPED.getTime() + 30 * 3_600_000)), provider: "mocked", isMocked: true };
    expect(computeEvidenceCompleteness(buildShipmentArtefacts({ order, paypalOrder, shipment, tracking: early, now: NOW, newId: ids }))).toBe(75);
    const none = buildShipmentArtefacts({ order, paypalOrder, shipment, tracking: { events: [], provider: "mocked", isMocked: true }, now: NOW, newId: ids });
    expect(none.map((r) => r.artefactType)).not.toContain("tracking_events");
  });

  it("events from a real provider are stored as tracking_api, not mocked", () => {
    const real = { events: delivered.events.map((e) => ({ ...e, isMocked: false })), provider: "real", isMocked: false };
    const rows = buildShipmentArtefacts({ order, paypalOrder, shipment, tracking: real, now: NOW, newId: ids });
    expect(rows.find((r) => r.artefactType === "tracking_events")).toMatchObject({ source: "tracking_api", isMocked: false });
  });
});

describe("buildCommunicationArtefact and summarizeEvidence", () => {
  it("records a message as a buyer_communication artefact, which completes the score", () => {
    const comm = buildCommunicationArtefact("order-1", { direction: "inbound", subject: "Re: shipped", body: "Thanks!", sentAt: NOW }, NOW, ids);
    expect(comm).toMatchObject({ artefactType: "buyer_communication", source: "merchant_input", payload: { direction: "inbound", subject: "Re: shipped", body: "Thanks!" } });
    const rows = [...buildShipmentArtefacts({ order, paypalOrder, shipment, tracking: delivered, now: NOW, newId: ids }), comm];
    const s = summarizeEvidence(rows as never);
    expect(s.completeness).toBe(100);
    expect(s.breakdown.every((i) => i.met)).toBe(true);
  });
});

describe("append-only (REQ-EV-03)", () => {
  it("the evidence repository and assembler contain no update or delete", () => {
    for (const file of ["repo.ts", "assembler.ts"]) {
      const text = readFileSync(join(__dirname, "..", file), "utf8");
      expect(text, file).not.toMatch(/\.update\(|\.delete\(|DELETE FROM|UPDATE evidence/i);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("evidence repo against the live database", () => {
  const orderId = randomUUID();
  afterAll(async () => {
    const { closeDb, getSql } = await import("@/db/client");
    await getSql()`DELETE FROM evidence_artefacts WHERE order_id = ${orderId}`;
    await getSql()`DELETE FROM orders WHERE id = ${orderId}`;
    await closeDb();
  });

  it("stores the built rows and reads them back in order", async () => {
    const { getSql } = await import("@/db/client");
    const { createDrizzleEvidenceRepo } = await import("../repo");
    const { assembleEvidence, getEvidenceByOrderId } = await import("../assembler");
    const now = new Date().toISOString();
    await getSql()`INSERT INTO orders (id, buyer_email, buyer_is_first_time, shipping_method, billing_country, shipping_country, amount_usd, status, is_seed, is_demo, created_at, updated_at, session_id)
                   VALUES (${orderId}, 'buyer@example.com', true, 'standard', 'US', 'US', 120, 'captured', false, true, ${now}, ${now}, 'evidence-live-test')`;
    const repo = createDrizzleEvidenceRepo();
    const stored = await assembleEvidence(repo, { order: { ...order, id: orderId }, paypalOrder, shipment, tracking: delivered, now: new Date() });
    expect(stored).toHaveLength(5);
    const read = await getEvidenceByOrderId(repo, orderId);
    expect(read.map((r) => r.artefactType).sort()).toEqual(["buyer_contact", "invoice_summary", "line_items", "tracking_events", "tracking_info"]);
    expect(summarizeEvidence(read).completeness).toBe(90);
    expect(read.find((r) => r.artefactType === "tracking_events")?.isMocked).toBe(true);
  });
});
