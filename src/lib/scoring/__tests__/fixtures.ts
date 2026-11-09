/** Shared builders for the scoring tests. Not a test file (vitest only runs *.test.ts). */
import type { ArtefactInput } from "../evidence-completeness";
import type { ScoringOrder } from "../signals";

export const BASELINE_USD = 85; // settings.merchant_avg_order_value_usd

/** A returning buyer, $50, standard shipping, US to US, ordinary email, one attempt: no signal fires. */
export const cleanOrder = (overrides: Partial<ScoringOrder> = {}): ScoringOrder => ({
  buyerEmail: "buyer@example.com",
  buyerIsFirstTime: false,
  paymentAttemptCount: 1,
  shippingMethod: "standard",
  billingCountry: "US",
  shippingCountry: "US",
  amountUsd: 50,
  ...overrides,
});

// ---- evidence artefacts -----------------------------------------------------
const artefact = (artefactType: string, payload: unknown = {}): ArtefactInput => ({ artefactType, payload });

export const trackingEvents = (...statuses: string[]): ArtefactInput =>
  artefact("tracking_events", {
    events: statuses.map((status) => ({
      timestamp: "2026-11-01T00:00:00.000Z",
      location: "Somewhere, US",
      status,
      isMocked: true,
    })),
  });

export const invoice = artefact("invoice_summary", { orderId: "X", amount: 1, currency: "USD" });
export const lineItems = artefact("line_items", { items: [] });
export const contact = artefact("buyer_contact", { email: "buyer@example.com" });
export const trackingInfo = artefact("tracking_info", { trackingNumber: "T1", carrier: "USPS" });
export const comms = artefact("buyer_communication", { direction: "outbound", subject: "s", body: "b" });

/** invoice + line items + contact + tracking number = 60 points, no scans, no messages. */
export const FOUR_BASICS: ArtefactInput[] = [invoice, lineItems, contact, trackingInfo];

/** Everything, with a Delivered scan: 100 points. */
export const FULL_DELIVERED: ArtefactInput[] = [
  ...FOUR_BASICS,
  trackingEvents("Label Created", "Picked Up", "In Transit", "Out for Delivery", "Delivered"),
  comms,
];
/** Everything, but the scans stop at In Transit: 85 points. */
export const FULL_IN_TRANSIT: ArtefactInput[] = [...FOUR_BASICS, trackingEvents("Picked Up", "In Transit"), comms];
/** Everything except any scan events: 70 points. */
export const FULL_NO_EVENTS: ArtefactInput[] = [...FOUR_BASICS, comms];

// ---- the seeded disputes' evidence (matches src/seed/data.ts) ------------------
export const SEED_C_EVIDENCE = FULL_DELIVERED; // 100
export const SEED_D_EVIDENCE = FOUR_BASICS; // 60
export const SEED_E_EVIDENCE: ArtefactInput[] = [...FOUR_BASICS, trackingEvents("Picked Up", "In Transit")]; // 75
