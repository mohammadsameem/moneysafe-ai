/**
 * Evidence assembly (M3-02, REQ-EV-01/03/04).
 *
 * Append-only: this module only ever BUILDS new artefact rows, and the repository it writes through
 * has no update or delete (a test checks that). Evidence that was stored is never changed.
 *
 *   invoice_summary   PayPal order (or the local order when PayPal was not used)
 *   line_items        PayPal order items (omitted when there is no PayPal order: nothing to cite)
 *   buyer_contact     the local order's buyer + the PayPal payer's name
 *   tracking_info     merchant input (number, carrier, ship time)
 *   tracking_events   the tracking provider, or mocked events labelled isMocked
 *   buyer_communication   appended one at a time, never at ship time
 */
import { randomUUID } from "node:crypto";
import type { EvidenceArtefact, NewEvidenceArtefact, Order } from "@/db/schema";
import type { PayPalOrder } from "@/lib/paypal";
import { computeEvidenceCompleteness, completenessBreakdown, type CompletenessItem } from "@/lib/scoring";
import type { TrackingResult } from "@/lib/tracking/types";

export interface EvidenceRepo {
  /** Inserts only. There is deliberately no update or delete. */
  insertArtefacts(rows: NewEvidenceArtefact[]): Promise<EvidenceArtefact[]>;
  /** Every artefact for one order, oldest first. */
  getEvidenceByOrderId(orderId: string): Promise<EvidenceArtefact[]>;
}

export interface ShipmentInput {
  trackingNumber: string;
  carrier: string;
  shippedAt: Date;
}

export interface BuildShipmentArgs {
  order: Order;
  /** Null when PayPal was not used (demo order, no credentials, Demo Mode, or PayPal unreachable). */
  paypalOrder: PayPalOrder | null;
  shipment: ShipmentInput;
  tracking: TrackingResult;
  now: Date;
  newId?: () => string;
}

const money = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** The artefacts recorded when an order ships. Pure. */
export function buildShipmentArtefacts(a: BuildShipmentArgs): NewEvidenceArtefact[] {
  const id = a.newId ?? randomUUID;
  const created = a.now.toISOString();
  const pp = a.paypalOrder;
  const unit = pp?.purchase_units[0];
  const rows: NewEvidenceArtefact[] = [];
  const push = (artefactType: NewEvidenceArtefact["artefactType"], payload: Record<string, unknown>, source: NewEvidenceArtefact["source"], isMocked = false) =>
    rows.push({ id: id(), orderId: a.order.id, artefactType, payload, source, isMocked, createdAt: created });

  push(
    "invoice_summary",
    {
      orderId: pp?.id ?? a.order.paypalOrderId ?? a.order.id,
      amount: money(unit?.amount?.value, a.order.amountUsd),
      currency: unit?.amount?.currency_code ?? a.order.currency,
      createdAt: pp?.create_time ?? a.order.createdAt,
      status: pp?.status ?? a.order.status.toUpperCase(),
    },
    pp ? "paypal_api" : "merchant_input",
  );

  const items = unit?.items ?? [];
  if (items.length > 0) {
    push(
      "line_items",
      { items: items.map((i) => ({ name: i.name, quantity: Number(i.quantity) || 1, unitAmount: money(i.unit_amount.value, 0), category: i.category ?? null })) },
      "paypal_api",
    );
  }

  const payerName = [pp?.payer?.name?.given_name, pp?.payer?.name?.surname].filter(Boolean).join(" ");
  push(
    "buyer_contact",
    { email: pp?.payer?.email_address ?? a.order.buyerEmail, ...(payerName ? { name: payerName } : {}), country: a.order.shippingCountry },
    pp?.payer ? "paypal_api" : "merchant_input",
  );

  push(
    "tracking_info",
    { trackingNumber: a.shipment.trackingNumber, carrier: a.shipment.carrier, shippedAt: a.shipment.shippedAt.toISOString() },
    "merchant_input",
  );

  if (a.tracking.events.length > 0) {
    push("tracking_events", { events: a.tracking.events }, a.tracking.isMocked ? "mocked" : "tracking_api", a.tracking.isMocked);
  }
  return rows;
}

export interface CommunicationInput {
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
  sentAt: Date;
}

/** One buyer communication, as an artefact. Its text is untrusted and is never placed in a prompt (only counts are). */
export function buildCommunicationArtefact(orderId: string, c: CommunicationInput, now: Date, newId: () => string = randomUUID): NewEvidenceArtefact {
  return {
    id: newId(),
    orderId,
    artefactType: "buyer_communication",
    payload: { direction: c.direction, subject: c.subject, body: c.body, sentAt: c.sentAt.toISOString() },
    source: "merchant_input",
    isMocked: false,
    createdAt: now.toISOString(),
  };
}

/** Builds and stores the shipment evidence. Returns the stored rows. */
export async function assembleEvidence(repo: EvidenceRepo, args: BuildShipmentArgs): Promise<EvidenceArtefact[]> {
  return repo.insertArtefacts(buildShipmentArtefacts(args));
}

export async function getEvidenceByOrderId(repo: EvidenceRepo, orderId: string): Promise<EvidenceArtefact[]> {
  return repo.getEvidenceByOrderId(orderId);
}

export interface EvidenceSummaryView {
  artefacts: EvidenceArtefact[];
  completeness: number;
  breakdown: CompletenessItem[];
}

export function summarizeEvidence(artefacts: EvidenceArtefact[]): EvidenceSummaryView {
  return { artefacts, completeness: computeEvidenceCompleteness(artefacts), breakdown: completenessBreakdown(artefacts) };
}
