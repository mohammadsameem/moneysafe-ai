/** Realistic evidence artefacts (the seeded shapes) shared by the dispute tests. Not a test file. */
import type { EvidenceArtefact } from "@/db/schema";
import type { ArtefactInput } from "@/lib/scoring";

export const BUYER_EMAIL = "jane.private@example.com";

export const art = (artefactType: string, payload: Record<string, unknown>): ArtefactInput => ({ artefactType, payload });

export const scans = (...statuses: string[]): ArtefactInput =>
  art("tracking_events", {
    events: statuses.map((status, i) => ({ timestamp: `2026-11-0${i + 1}T10:00:00.000Z`, location: "Charlotte, NC", status, isMocked: true })),
  });

export const basics = (item = "Hand-thrown stoneware dinner set"): ArtefactInput[] => [
  art("invoice_summary", { orderId: "SEED-A", amount: 145, currency: "USD" }),
  art("line_items", { items: [{ name: item, quantity: 1, unitAmount: 145 }] }),
  art("buyer_contact", { email: BUYER_EMAIL, name: "Jane Private", addressLine1: "12 Secret Street", city: "Springfield", country: "US" }),
  art("tracking_info", { trackingNumber: "9400111899223197428490", carrier: "USPS", shippedAt: "2026-11-01T08:00:00.000Z" }),
];

export const comm = (direction: "inbound" | "outbound"): ArtefactInput =>
  art("buyer_communication", { direction, subject: "s", body: "PRIVATE MESSAGE TEXT" });

/** Complete evidence ending in a Delivered scan, with messages both ways: completeness 100. */
export const SEED_C = [...basics(), scans("Label Created", "Picked Up", "In Transit", "Out for Delivery", "Delivered"), comm("outbound"), comm("inbound")];
/** The four basics only: completeness 60. */
export const SEED_D = basics("Hand-dyed wool scarf");
/** The basics plus scans that stop at In Transit: completeness 75. */
export const SEED_E = [...basics("Hand-woven wool area rug"), scans("Picked Up", "In Transit")];

/** Database-shaped rows for an order, for repositories that return EvidenceArtefact. */
export function artefactRows(orderId: string, inputs: readonly ArtefactInput[]): EvidenceArtefact[] {
  return inputs.map((a, i) => ({
    id: `art-${orderId}-${i}`,
    orderId,
    artefactType: a.artefactType as EvidenceArtefact["artefactType"],
    payload: a.payload as Record<string, unknown>,
    source: "seed",
    isMocked: false,
    createdAt: "2026-11-01T08:00:00.000Z",
  }));
}
