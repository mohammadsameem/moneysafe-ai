/**
 * Canonical seed data for MoneySafe AI (tasks.md M1-03, requirements REQ-DEMO-02..07).
 *
 * - No LLM calls: every piece of explanatory text below is hand-written.
 * - Derived numbers (risk scores, completeness, win probabilities, recommendations) are computed
 *   from the seeded evidence via src/lib/scoring (the same code the app uses), then cross-checked
 *   against the expected numbers by assertSeedConsistency().
 * - Timestamps are relative to `now`, so seeded data always looks fresh and the open disputes
 *   never expire. Open seed disputes additionally store deadline_offset_hours; the app computes
 *   deadline_at from it at read time (design 3.4), so the stored deadline_at is a placeholder.
 */
import type {
  NewDispute,
  NewDisputeOutcome,
  NewEvidenceArtefact,
  NewInsightsCacheRow,
  NewOrder,
  NewSettings,
  NewSignalWeights,
} from "../db/schema";
import { computeInsightsFingerprint } from "../lib/insights/fingerprint";
import { seedId } from "./ids";
// The single scoring implementation. The seed computes its derived numbers with the same
// functions the app uses, so the unit tests in src/lib/scoring cover what the seed relies on.
import {
  DEFAULT_SIGNAL_WEIGHTS,
  computeBaseWinProbability,
  computeEvidenceCompleteness,
  computeRiskScore,
  computeSystemRecommendation,
  computeWinProbability,
  contestExpectedValue,
  evaluateSignals,
  toVerdict,
  toWinLikelihoodLabel,
  trackingStatuses,
  type ArtefactInput,
} from "../lib/scoring";

/** settings.merchant_avg_order_value_usd (fixed baseline; REQ-ORD-02). */
const BASELINE_AVG_USD = 85;
/** Defaults of CHARGEBACK_FEE_USD / CONTEST_EFFORT_USD. The seeded reasoning text quotes these figures. */
const CHARGEBACK_FEE_USD = 20;
const CONTEST_EFFORT_USD = 10;

export interface SeedBundle {
  settings: NewSettings;
  weights: NewSignalWeights;
  orders: NewOrder[];
  artefacts: NewEvidenceArtefact[];
  disputes: NewDispute[];
  outcomes: NewDisputeOutcome[];
  insights: NewInsightsCacheRow;
}

/** Placeholder for open seed disputes; the real deadline is now + deadline_offset_hours at read time. */
export const SEED_DEADLINE_PLACEHOLDER = "2099-01-01T00:00:00Z";

const HOUR = 3_600_000;
const DAY = 24;
const at = (now: Date, hoursFromNow: number): string => new Date(now.getTime() + hoursFromNow * HOUR).toISOString();
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const money = (n: number): string => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

// ---------------------------------------------------------------------------
// Order specs
// ---------------------------------------------------------------------------
type ScanStatus = "Label Created" | "Picked Up" | "In Transit" | "Out for Delivery" | "Delivered";
interface Scan {
  afterHours: number;
  location: string;
  status: ScanStatus;
}
interface Comm {
  afterHours: number;
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
}
interface Shipment {
  hoursAgo: number;
  carrier: "USPS" | "UPS" | "FEDEX";
  trackingNumber: string;
  scans: Scan[];
  comms: Comm[];
}
interface OrderSpec {
  key: string;
  buyerName: string;
  email: string;
  firstTime: boolean;
  shippingMethod: "standard" | "express" | "overnight" | "rush";
  shippingCountry: string;
  amount: number;
  itemName: string;
  addressLine1: string;
  city: string;
  createdHoursAgo: number;
  shipment?: Shipment; // absent = not shipped yet (status "captured")
  risk?: { explanation: string; verificationDraft?: { subject: string; body: string } };
}

const MERCHANT_ORIGIN = "Asheville, NC";

/** Label created -> picked up -> two hops -> out for delivery -> Delivered (all mocked). */
const fullDelivery = (destination: string, hops: [string, string]): Scan[] => [
  { afterHours: 0, location: MERCHANT_ORIGIN, status: "Label Created" },
  { afterHours: 4, location: MERCHANT_ORIGIN, status: "Picked Up" },
  { afterHours: 28, location: hops[0], status: "In Transit" },
  { afterHours: 52, location: hops[1], status: "In Transit" },
  { afterHours: 74, location: destination, status: "Out for Delivery" },
  { afterHours: 78, location: destination, status: "Delivered" },
];

const shippedNotice = (name: string, item: string, carrier: string, tracking: string): Comm => ({
  afterHours: 1,
  direction: "outbound",
  subject: "Your order has shipped",
  body: `Hi ${name.split(" ")[0]}, your ${item.toLowerCase()} has shipped with ${carrier} (tracking ${tracking}). Thank you for supporting a small shop!`,
});

const ORDER_SPECS: OrderSpec[] = [
  {
    key: "SEED-A",
    buyerName: "Priya Nair",
    email: "priya.nair@example.com",
    firstTime: false,
    shippingMethod: "standard",
    shippingCountry: "US",
    amount: 145,
    itemName: "Hand-thrown stoneware dinner set (4 pieces)",
    addressLine1: "2208 Cedar Ridge Dr",
    city: "Austin, TX",
    createdHoursAgo: 10 * DAY,
    shipment: {
      hoursAgo: 9 * DAY,
      carrier: "USPS",
      trackingNumber: "9400111899223197428490",
      scans: fullDelivery("Austin, TX", ["Atlanta, GA", "Dallas, TX"]),
      comms: [
        shippedNotice("Priya Nair", "stoneware dinner set", "USPS", "9400111899223197428490"),
        {
          afterHours: 5,
          direction: "inbound",
          subject: "Re: Your order has shipped",
          body: "Thank you! I can't wait to use it this weekend.",
        },
      ],
    },
  },
  {
    key: "SEED-B",
    buyerName: "Daniel Okafor",
    email: "d.okafor@example.com",
    firstTime: true,
    shippingMethod: "rush",
    shippingCountry: "GB",
    amount: 210,
    itemName: "Hand-knitted merino wool throw blanket",
    addressLine1: "27 Hawthorn Road",
    city: "London",
    createdHoursAgo: 20,
    risk: {
      explanation:
        "This order scores 55 out of 100 (Verify first). Three signals fired: the billing country (US) differs from the shipping country (UK), the buyer is new to your shop and the order is $210, above the $200 high-value line, and they chose rush shipping. Any one of these is common for honest buyers, for example someone sending a gift abroad. Together they are worth a quick confirmation before you ship.",
      verificationDraft: {
        subject: "Quick confirmation for your order",
        body: "Hi Daniel,\n\nThank you for your order of the hand-knitted merino throw blanket. Because the billing address (US) and the delivery address (UK) are different, I like to confirm gift and international orders before they ship.\n\nCould you reply to confirm that the UK delivery address is correct and that you placed this order? As soon as I hear back I will pack it and send it out with rush delivery.\n\nThank you so much,\n[Your name]",
      },
    },
  },
  {
    key: "SEED-D-ORD",
    buyerName: "Elena Rossi",
    email: "elena.rossi@example.com",
    firstTime: false,
    shippingMethod: "standard",
    shippingCountry: "US",
    amount: 38,
    itemName: "Hand-dyed silk scarf, forest green",
    addressLine1: "88 Lakeview Terrace",
    city: "Madison, WI",
    createdHoursAgo: 8 * DAY,
    shipment: { hoursAgo: 7 * DAY, carrier: "USPS", trackingNumber: "9400111899223197428512", scans: [], comms: [] },
  },
  {
    key: "SEED-E-ORD",
    buyerName: "Marcus Webb",
    email: "marcus.webb@example.com",
    firstTime: true,
    shippingMethod: "standard",
    shippingCountry: "CA",
    amount: 210,
    itemName: "Hand-woven wool area rug, 3 x 5 ft",
    addressLine1: "15 Queen Mary Crescent",
    city: "Toronto, ON",
    createdHoursAgo: 7 * DAY,
    shipment: {
      hoursAgo: 6 * DAY,
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      scans: [
        { afterHours: 0, location: MERCHANT_ORIGIN, status: "Label Created" },
        { afterHours: 5, location: MERCHANT_ORIGIN, status: "Picked Up" },
        { afterHours: 30, location: "Buffalo, NY", status: "In Transit" },
        { afterHours: 62, location: "Toronto, ON (customs clearance)", status: "In Transit" },
      ],
      comms: [],
    },
    risk: {
      explanation:
        "This order scores 40 out of 100 (Verify first), right at the threshold. Two signals fired: the billing country (US) differs from the shipping country (Canada), and the buyer is new to your shop spending $210, above the $200 high-value line. Standard shipping, a normal email address and a single payment attempt added no risk. It is a borderline case: a short check is reasonable but not urgent.",
      verificationDraft: {
        subject: "Quick confirmation for your order",
        body: "Hi Marcus,\n\nThank you for your order of the hand-woven wool area rug. Because the billing address (US) and the delivery address (Canada) are different, I like to confirm international orders before they ship.\n\nCould you reply to confirm that the Toronto delivery address is correct? Once I hear back I will get it on its way.\n\nThank you,\n[Your name]",
      },
    },
  },
  {
    key: "SEED-F",
    buyerName: "Chris Lindqvist",
    email: "tmp.chris.4471@mailinator.com",
    firstTime: false,
    shippingMethod: "rush",
    shippingCountry: "DE",
    amount: 320,
    itemName: "Hand-carved walnut chess set",
    addressLine1: "Kastanienallee 12",
    city: "Berlin",
    createdHoursAgo: 5,
    risk: {
      explanation:
        "This order scores 70 out of 100 (Hold). Four signals fired: the billing country (US) differs from the shipping country (Germany), the $320 total is more than three times your usual $85 order, rush shipping was selected, and the email address is from a disposable-mail service (mailinator.com). The buyer has ordered from you before, which is in their favour but is not part of the score. I would hold shipment until you have confirmed the order with the buyer.",
    },
  },
  {
    key: "H1-ORD",
    buyerName: "Grace Holloway",
    email: "grace.holloway@example.com",
    firstTime: false,
    shippingMethod: "standard",
    shippingCountry: "US",
    amount: 89,
    itemName: "Hand-poured soy candle gift set (3 candles)",
    addressLine1: "905 Willow Court",
    city: "Columbus, OH",
    createdHoursAgo: 62 * DAY,
    shipment: {
      hoursAgo: 61 * DAY,
      carrier: "USPS",
      trackingNumber: "9400111899223197428539",
      scans: fullDelivery("Columbus, OH", ["Charlotte, NC", "Pittsburgh, PA"]),
      comms: [shippedNotice("Grace Holloway", "candle gift set", "USPS", "9400111899223197428539")],
    },
  },
  {
    key: "H2-ORD",
    buyerName: "Tom Brennan",
    email: "tom.brennan@example.com",
    firstTime: false,
    shippingMethod: "standard",
    shippingCountry: "US",
    amount: 134,
    itemName: "Hand-stitched leather weekender bag",
    addressLine1: "3 Harbor View",
    city: "Portland, ME",
    createdHoursAgo: 50 * DAY,
    shipment: {
      hoursAgo: 49 * DAY,
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456791",
      scans: fullDelivery("Portland, ME", ["Richmond, VA", "Boston, MA"]),
      comms: [shippedNotice("Tom Brennan", "leather weekender bag", "UPS", "1Z999AA10123456791")],
    },
  },
  {
    key: "H3-ORD",
    buyerName: "Sofia Alvarez",
    email: "sofia.alvarez@example.com",
    firstTime: true,
    shippingMethod: "standard",
    shippingCountry: "US",
    amount: 210,
    itemName: "Hand-blown glass pendant lights (pair)",
    addressLine1: "7740 Mesa Verde Blvd",
    city: "Phoenix, AZ",
    createdHoursAgo: 44 * DAY,
    shipment: { hoursAgo: 43 * DAY, carrier: "FEDEX", trackingNumber: "794644790138", scans: [], comms: [] },
  },
  {
    key: "H4-ORD",
    buyerName: "Noah Fischer",
    email: "noah.fischer@example.com",
    firstTime: false,
    shippingMethod: "standard",
    shippingCountry: "US",
    amount: 42,
    itemName: "Macrame wall hanging",
    addressLine1: "61 Pine Hollow Rd",
    city: "Burlington, VT",
    createdHoursAgo: 33 * DAY,
    shipment: { hoursAgo: 32 * DAY, carrier: "USPS", trackingNumber: "9400111899223197428607", scans: [], comms: [] },
  },
  {
    key: "H5-ORD",
    buyerName: "Ines Duarte",
    email: "ines.duarte@example.com",
    firstTime: false,
    shippingMethod: "standard",
    shippingCountry: "US",
    amount: 67,
    itemName: "Hand-painted ceramic planter set (2)",
    addressLine1: "19 Orchard Lane",
    city: "Savannah, GA",
    createdHoursAgo: 26 * DAY,
    shipment: { hoursAgo: 25 * DAY, carrier: "USPS", trackingNumber: "9400111899223197428614", scans: [], comms: [] },
  },
];

// ---------------------------------------------------------------------------
// Dispute specs
// ---------------------------------------------------------------------------
type Reason = "item_not_received" | "not_as_described";
type Outcome = "won" | "lost" | "refunded";

interface OpenText {
  reasoning: (ctx: { completeness: number; basePct: number; shownPct: number; ev: string }) => string;
  draftResponse: string | null;
  buyerMessage: string;
}
interface DisputeSpec {
  key: string;
  orderKey: string;
  reason: Reason;
  createdHoursAgo: number;
  /** Open seed disputes: hours from now until the deadline. */
  deadlineOffsetHours?: number;
  open?: OpenText;
  /** Resolved (historical) disputes. */
  resolved?: { outcome: Outcome; resolvedHoursAgo: number; buyerMessage: string };
}

const DISPUTE_SPECS: DisputeSpec[] = [
  {
    key: "SEED-C",
    orderKey: "SEED-A",
    reason: "item_not_received",
    createdHoursAgo: 30,
    deadlineOffsetHours: 72,
    open: {
      buyerMessage: "I never received my order. The tracking says delivered but nothing arrived at my door.",
      reasoning: ({ completeness, basePct, shownPct, ev }) =>
        `The evidence set is complete: invoice, line items, buyer contact, tracking number and carrier, a scan history that ends in Delivered, and the buyer's reply to your shipping message. Completeness is ${completeness}%, which gives a base win likelihood of ${basePct}%, shown as ${shownPct}% because estimates are capped at 95%. At $145, contesting has an expected value of about ${ev} after the $20 chargeback fee and $10 effort cost. Recommendation: contest.`,
      draftResponse:
        "Hello PayPal Dispute Team,\n\nI am responding to the item-not-received claim on this order (hand-thrown stoneware dinner set, $145). The order shipped with USPS under tracking number 9400111899223197428490. The carrier's scan history shows the parcel was picked up, moved through the network, went out for delivery and was marked Delivered at the buyer's address. The buyer also replied to my shipping confirmation to say they were looking forward to using it.\n\nI have attached the invoice, line items, delivery address, tracking details and message history. I believe the item was delivered as described and ask that the claim be decided in my favour.\n\nThank you,\n[Your name]",
    },
  },
  {
    key: "SEED-D",
    orderKey: "SEED-D-ORD",
    reason: "not_as_described",
    createdHoursAgo: 20,
    deadlineOffsetHours: 48,
    open: {
      buyerMessage: "The scarf looks different from the photos. The green is much duller than the listing.",
      reasoning: ({ completeness, basePct, ev }) =>
        `Only the invoice, line items, buyer contact and tracking number are on file (${completeness}% complete). There are no carrier scan events, and delivery proof would not answer this claim anyway: the buyer is disputing how the item looks, not whether it arrived. With no buyer messages supporting the listing, the base win likelihood is ${basePct}%. At $38, contesting has an expected value of about ${ev} after the $20 chargeback fee and $10 effort cost, so a refund is the cheaper outcome. Recommendation: refund.`,
      draftResponse: null,
    },
  },
  {
    key: "SEED-E",
    orderKey: "SEED-E-ORD",
    reason: "item_not_received",
    createdHoursAgo: 10,
    deadlineOffsetHours: 40,
    open: {
      buyerMessage: "My rug has not arrived and the tracking has not moved in days.",
      reasoning: ({ completeness, basePct, ev }) =>
        `Tracking shows the parcel was picked up and is in transit, but there is no Delivered scan and no buyer messages are on file (${completeness}% complete). The base win likelihood is ${basePct}%, which is Moderate. At $210 the numbers still favour contesting: the expected value is about ${ev} after the $20 chargeback fee and $10 effort cost. The weak point is the missing delivery confirmation, so the response should rely on proof of shipment and ask for the case to stay open until the carrier completes delivery. Recommendation: contest.`,
      draftResponse:
        "Hello PayPal Dispute Team,\n\nI am responding to the item-not-received claim on this order (hand-woven wool area rug, $210). I shipped it with UPS under tracking number 1Z999AA10123456784. The carrier's latest scan shows the parcel in transit and clearing customs for delivery to Canada, so it has not been reported lost or returned.\n\nI have attached the invoice, line items, buyer details and the tracking record as proof of shipment. International parcels can take longer, and I ask that the case stays open until the carrier completes delivery.\n\nThank you,\n[Your name]",
    },
  },
  {
    key: "H1",
    orderKey: "H1-ORD",
    reason: "item_not_received",
    createdHoursAgo: 45 * DAY,
    resolved: {
      outcome: "won",
      resolvedHoursAgo: 38 * DAY,
      buyerMessage: "The candle set never showed up at my address.",
    },
  },
  {
    key: "H2",
    orderKey: "H2-ORD",
    reason: "item_not_received",
    createdHoursAgo: 36 * DAY,
    resolved: { outcome: "won", resolvedHoursAgo: 29 * DAY, buyerMessage: "I did not receive the bag." },
  },
  {
    key: "H3",
    orderKey: "H3-ORD",
    reason: "not_as_described",
    createdHoursAgo: 30 * DAY,
    resolved: {
      outcome: "lost",
      resolvedHoursAgo: 22 * DAY,
      buyerMessage: "The pendant lights are a different size and finish than the listing showed.",
    },
  },
  {
    key: "H4",
    orderKey: "H4-ORD",
    reason: "item_not_received",
    createdHoursAgo: 24 * DAY,
    resolved: {
      outcome: "refunded",
      resolvedHoursAgo: 18 * DAY,
      buyerMessage: "The wall hanging has not arrived.",
    },
  },
  {
    key: "H5",
    orderKey: "H5-ORD",
    reason: "not_as_described",
    createdHoursAgo: 16 * DAY,
    resolved: {
      outcome: "refunded",
      resolvedHoursAgo: 9 * DAY,
      buyerMessage: "The planters are smaller than I expected from the photos.",
    },
  },
];

// ---------------------------------------------------------------------------
// Text helpers for evidence labels / gaps
// ---------------------------------------------------------------------------
function evidenceUsedLabels(arts: ArtefactInput[]): string[] {
  const statuses = trackingStatuses(arts);
  const has = (t: string) => arts.some((a) => a.artefactType === t);
  const labels: string[] = [];
  if (has("invoice_summary")) labels.push("Invoice / order summary");
  if (has("line_items")) labels.push("Order line items");
  if (has("buyer_contact")) labels.push("Buyer contact details");
  if (has("tracking_info")) labels.push("Tracking number and carrier");
  if (statuses.length > 0) {
    labels.push(
      statuses.includes("Delivered")
        ? "Carrier scan history ending in Delivered (mocked)"
        : "Carrier scan history, In Transit only (mocked)",
    );
  }
  if (has("buyer_communication")) labels.push("Buyer communications");
  return labels;
}

function evidenceGapLabels(arts: ArtefactInput[]): string[] {
  const statuses = trackingStatuses(arts);
  const gaps: string[] = [];
  if (statuses.length === 0) gaps.push("No carrier scan events on file");
  else if (!statuses.includes("Delivered")) gaps.push("No Delivered scan: tracking stops at In Transit");
  if (!arts.some((a) => a.artefactType === "buyer_communication")) gaps.push("No buyer communications on file");
  return gaps;
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------
export function buildSeedBundle(now: Date = new Date()): SeedBundle {
  const weightsId = seedId("weights", "active");
  const orderId = (key: string) => seedId("order", key);

  // ---- orders + evidence ----------------------------------------------------
  const orders: NewOrder[] = [];
  const artefacts: NewEvidenceArtefact[] = [];
  const artefactsByOrder = new Map<string, ArtefactInput[]>();
  const orderScore = new Map<string, { score: number; verdict: "ship" | "verify" | "hold" }>();

  for (const spec of ORDER_SPECS) {
    const createdAt = at(now, -spec.createdHoursAgo);
    const shipment = spec.shipment;
    const shippedAtMs = shipment ? now.getTime() - shipment.hoursAgo * HOUR : undefined;
    const shippedAt = shippedAtMs === undefined ? undefined : new Date(shippedAtMs).toISOString();

    const rows: { artefactType: NewEvidenceArtefact["artefactType"]; payload: Record<string, unknown>; mocked: boolean; n: number; created: string }[] = [];
    const push = (
      artefactType: NewEvidenceArtefact["artefactType"],
      payload: Record<string, unknown>,
      created: string,
      mocked = false,
    ) => rows.push({ artefactType, payload, mocked, n: rows.filter((r) => r.artefactType === artefactType).length, created });

    if (shipment && shippedAt) {
      push("invoice_summary", { orderId: spec.key, amount: spec.amount, currency: "USD", createdAt, status: "COMPLETED" }, shippedAt);
      push(
        "line_items",
        { items: [{ name: spec.itemName, quantity: 1, unitAmount: spec.amount, category: "PHYSICAL_GOODS" }] },
        shippedAt,
      );
      push(
        "buyer_contact",
        { email: spec.email, name: spec.buyerName, addressLine1: spec.addressLine1, city: spec.city, country: spec.shippingCountry },
        shippedAt,
      );
      push("tracking_info", { trackingNumber: shipment.trackingNumber, carrier: shipment.carrier, shippedAt }, shippedAt);
      if (shipment.scans.length > 0) {
        push(
          "tracking_events",
          {
            events: shipment.scans.map((s) => ({
              timestamp: new Date(shippedAtMs! + s.afterHours * HOUR).toISOString(),
              location: s.location,
              status: s.status,
              isMocked: true,
            })),
          },
          shippedAt,
          true,
        );
      }
      for (const c of shipment.comms) {
        push(
          "buyer_communication",
          {
            direction: c.direction,
            subject: c.subject,
            body: c.body,
            sentAt: new Date(shippedAtMs! + c.afterHours * HOUR).toISOString(),
          },
          shippedAt,
        );
      }
    }

    for (const r of rows) {
      artefacts.push({
        id: seedId("artefact", `${spec.key}:${r.artefactType}:${r.n}`),
        orderId: orderId(spec.key),
        artefactType: r.artefactType,
        payload: r.payload,
        // Seed events are labelled "mocked" in the Evidence Vault (REQ-DEMO-05).
        source: r.mocked ? "mocked" : "seed",
        isMocked: r.mocked,
        createdAt: r.created,
      });
    }
    const arts: ArtefactInput[] = rows.map((r) => ({ artefactType: r.artefactType, payload: r.payload }));
    artefactsByOrder.set(spec.key, arts);

    const signals = evaluateSignals(
      {
        buyerEmail: spec.email,
        buyerIsFirstTime: spec.firstTime,
        paymentAttemptCount: 1,
        shippingMethod: spec.shippingMethod,
        billingCountry: "US",
        shippingCountry: spec.shippingCountry,
        amountUsd: spec.amount,
      },
      DEFAULT_SIGNAL_WEIGHTS,
      BASELINE_AVG_USD,
    );
    const score = computeRiskScore(signals);
    const verdict = toVerdict(score);
    orderScore.set(spec.key, { score, verdict });

    orders.push({
      id: orderId(spec.key),
      paypalOrderId: null,
      paypalCaptureId: null,
      buyerEmail: spec.email,
      buyerIsFirstTime: spec.firstTime,
      paymentAttemptCount: 1,
      shippingMethod: spec.shippingMethod,
      billingCountry: "US",
      shippingCountry: spec.shippingCountry,
      amountUsd: spec.amount,
      currency: "USD",
      status: shipment ? "shipped" : "captured",
      riskScore: score,
      verdict,
      aiExplanation: spec.risk?.explanation ?? null,
      usedFallback: false,
      verificationDraft: spec.risk?.verificationDraft ?? null,
      evidenceCompleteness: shipment ? computeEvidenceCompleteness(arts) : null,
      signalBreakdown: signals,
      weightsId,
      sessionId: null,
      isSeed: true,
      isDemo: false,
      createdAt,
      updatedAt: shippedAt ?? createdAt,
    });
  }

  // ---- disputes + outcomes --------------------------------------------------
  const disputes: NewDispute[] = [];
  const outcomes: NewDisputeOutcome[] = [];
  const orderAmount = new Map(ORDER_SPECS.map((o) => [o.key, o.amount]));

  for (const spec of DISPUTE_SPECS) {
    const arts = artefactsByOrder.get(spec.orderKey)!;
    const amount = orderAmount.get(spec.orderKey)!;
    const risk = orderScore.get(spec.orderKey)!;

    const completeness = computeEvidenceCompleteness(arts);
    const baseExact = computeBaseWinProbability(completeness, arts, spec.reason);
    const base = round4(baseExact);
    const winProbability = round4(computeWinProbability(baseExact, 0));
    const recommendation = computeSystemRecommendation(amount, baseExact, CHARGEBACK_FEE_USD, CONTEST_EFFORT_USD);
    const ev = contestExpectedValue(amount, baseExact, CHARGEBACK_FEE_USD, CONTEST_EFFORT_USD);
    const createdAt = at(now, -spec.createdHoursAgo);

    const common = {
      id: seedId("dispute", spec.key),
      paypalDisputeId: null,
      orderId: orderId(spec.orderKey),
      reason: spec.reason,
      disputedAmountUsd: amount,
      baseWinProbability: base,
      llmAdjustment: 0, // seeded analyses never use the LLM
      winProbability,
      winLikelihoodLabel: toWinLikelihoodLabel(winProbability),
      systemRecommendation: recommendation,
      overrideRecommendation: null,
      finalRecommendation: recommendation,
      recommendationSource: "system" as const,
      evidenceUsed: evidenceUsedLabels(arts),
      evidenceGaps: evidenceGapLabels(arts),
      riskScoreSnapshot: risk.score,
      sessionId: null,
      isSeed: true,
      isDemo: false,
      createdAt,
    };

    if (spec.open) {
      disputes.push({
        ...common,
        buyerMessage: spec.open.buyerMessage,
        deadlineOffsetHours: spec.deadlineOffsetHours!,
        deadlineAt: SEED_DEADLINE_PLACEHOLDER,
        status: "open",
        outcome: null,
        outcomeIsSimulated: false,
        reasoning: spec.open.reasoning({
          completeness,
          basePct: Math.round(baseExact * 100),
          shownPct: Math.round(winProbability * 100),
          ev: money(ev),
        }),
        draftResponse: spec.open.draftResponse,
        analysisComputedAt: at(now, -spec.createdHoursAgo + 1),
        updatedAt: at(now, -spec.createdHoursAgo + 1),
      });
    } else if (spec.resolved) {
      const { outcome, resolvedHoursAgo, buyerMessage } = spec.resolved;
      const resolvedAt = at(now, -resolvedHoursAgo);
      const statusByOutcome = { won: "resolved_won", lost: "resolved_lost", refunded: "resolved_refunded" } as const;
      const reasoning =
        outcome === "won"
          ? `Historical demo record. Contested with a complete evidence set (${completeness}% complete, scan history ending in Delivered) and the claim was decided in the merchant's favour.`
          : outcome === "lost"
            ? `Historical demo record. Contested with thin evidence (${completeness}% complete, no buyer messages on file) and the claim was decided for the buyer.`
            : `Historical demo record. With thin evidence (${completeness}% complete) and a low amount, the expected value of contesting was negative, so the merchant refunded.`;
      disputes.push({
        ...common,
        buyerMessage,
        deadlineOffsetHours: null,
        // Resolved history keeps a real (past) deadline; only open seeds use the offset.
        deadlineAt: at(now, -spec.createdHoursAgo + 10 * DAY),
        status: statusByOutcome[outcome],
        outcome,
        outcomeIsSimulated: false,
        reasoning,
        draftResponse: null,
        analysisComputedAt: at(now, -spec.createdHoursAgo + 1),
        updatedAt: resolvedAt,
      });
      outcomes.push({
        id: seedId("outcome", spec.key),
        disputeId: common.id,
        outcome,
        riskScoreSnapshot: risk.score,
        verdictSnapshot: risk.verdict,
        winProbabilitySnapshot: winProbability,
        signalWeightsId: weightsId,
        isSimulated: false,
        createdAt: resolvedAt,
      });
    }
  }

  // ---- settings + signal weights (with a pending proposal) -------------------
  const settings: NewSettings = {
    id: seedId("settings", "main"),
    merchantAvgOrderValueUsd: BASELINE_AVG_USD,
    createdAt: at(now, -60 * DAY),
    updatedAt: at(now, -60 * DAY),
  };

  const proposalCreatedAt = at(now, -6);
  const weights: NewSignalWeights = {
    id: weightsId,
    countryMismatch: DEFAULT_SIGNAL_WEIGHTS.country_mismatch,
    firstTimeHighValue: DEFAULT_SIGNAL_WEIGHTS.first_time_high_value,
    rushShipping: DEFAULT_SIGNAL_WEIGHTS.rush_shipping,
    highRelativeValue: DEFAULT_SIGNAL_WEIGHTS.high_relative_value,
    disposableEmail: DEFAULT_SIGNAL_WEIGHTS.disposable_email,
    repeatedAttempts: DEFAULT_SIGNAL_WEIGHTS.repeated_attempts,
    isActive: true,
    // Counter stays at 0: a proposal is already pending, so it must not re-trigger (REQ-LL-02).
    resolvedSinceLastProposal: 0,
    // One change, within the +/-3 cap and the [5, 30] range; everything else is unchanged.
    proposedCountryMismatch: 20,
    proposedFirstTimeHighValue: 23,
    proposedRushShipping: 15,
    proposedHighRelativeValue: 20,
    proposedDisposableEmail: 15,
    proposedRepeatedAttempts: 10,
    proposalReasoning:
      "Of the five resolved disputes in the demo history, the only loss (H3, $210) came from a first-time buyer on a high-value order, while both wins were returning buyers with complete evidence. That suggests first-time, high-value orders deserve slightly more weight. Proposed: raise 'first-time buyer, high value' from 20 to 23 (+3). The other five weights stay as they are. Five outcomes is a very small sample, so the change is capped at 3 points per cycle and nothing is applied until you approve it.",
    proposalCreatedAt,
    createdAt: at(now, -60 * DAY),
    updatedAt: proposalCreatedAt,
  };

  // ---- insights cache (deterministic, hand-written; fingerprint matches the app's) -----
  const latestOutcome = outcomes.reduce((a, b) => (a.createdAt! > b.createdAt! ? a : b));
  const insights: NewInsightsCacheRow = {
    id: seedId("insights", "main"),
    summary:
      "Of the 5 resolved disputes in this demo data, 2 were won, 1 was lost and 2 ended in refunds. Both wins were item-not-received claims backed by a full evidence set and a Delivered scan. The loss was a not-as-described claim on a $210 first-time order with thin evidence. One change is waiting for your review: raise the first-time, high-value signal from 20 to 23. With only five outcomes this is a small adjustment, capped at 3 points per cycle, and nothing changes until you approve it.",
    usedFallback: false,
    inputFingerprint: computeInsightsFingerprint({
      outcomeCount: outcomes.length,
      latestOutcomeId: latestOutcome.id!,
      proposalCreatedAt,
      weights: DEFAULT_SIGNAL_WEIGHTS,
    }),
    generatedAt: at(now, 0),
  };

  return { settings, weights, orders, artefacts, disputes, outcomes, insights };
}

// ---------------------------------------------------------------------------
// Consistency guard: runs before every seed write
// ---------------------------------------------------------------------------
const EXPECTED_ORDERS: Record<string, { score: number; verdict: "ship" | "verify" | "hold" }> = {
  "SEED-A": { score: 0, verdict: "ship" },
  "SEED-B": { score: 55, verdict: "verify" },
  "SEED-D-ORD": { score: 0, verdict: "ship" },
  "SEED-E-ORD": { score: 40, verdict: "verify" },
  "SEED-F": { score: 70, verdict: "hold" },
};
const EXPECTED_OPEN: Record<string, { pct: number; recommendation: "contest" | "refund"; label: string; offset: number }> = {
  "SEED-C": { pct: 95, recommendation: "contest", label: "Strong", offset: 72 },
  "SEED-D": { pct: 27, recommendation: "refund", label: "Weak", offset: 48 },
  "SEED-E": { pct: 44, recommendation: "contest", label: "Moderate", offset: 40 },
};
const EXPECTED_RESOLVED: Record<Outcome, number> = { won: 2, lost: 1, refunded: 2 };

/** Throws with a readable list if the seed data disagrees with the spec. Never touches the database. */
export function assertSeedConsistency(bundle: SeedBundle): void {
  const problems: string[] = [];
  const orderKeyById = new Map(ORDER_SPECS.map((o) => [seedId("order", o.key), o.key]));
  const disputeKeyById = new Map(DISPUTE_SPECS.map((d) => [seedId("dispute", d.key), d.key]));

  for (const [key, want] of Object.entries(EXPECTED_ORDERS)) {
    const o = bundle.orders.find((x) => orderKeyById.get(x.id!) === key);
    if (!o) problems.push(`order ${key} is missing`);
    else {
      if (o.riskScore !== want.score) problems.push(`${key}: risk_score ${o.riskScore} != ${want.score}`);
      if (o.verdict !== want.verdict) problems.push(`${key}: verdict ${o.verdict} != ${want.verdict}`);
      if (want.score >= 1 && !o.aiExplanation) problems.push(`${key}: missing hand-written ai_explanation`);
      if (want.verdict === "verify" && !o.verificationDraft) problems.push(`${key}: missing verification_draft`);
      if (want.verdict !== "verify" && o.verificationDraft) problems.push(`${key}: unexpected verification_draft`);
      if (o.usedFallback !== false) problems.push(`${key}: used_fallback must be false`);
    }
  }

  for (const o of bundle.orders) {
    const spec = ORDER_SPECS.find((s) => seedId("order", s.key) === o.id)!;
    const itemTotal = spec.amount; // one line item per order, quantity 1
    if (o.amountUsd !== itemTotal) problems.push(`${spec.key}: amount mismatch`);
    const active = (o.signalBreakdown ?? []).filter((s) => s.active).reduce((n, s) => n + s.weight, 0);
    if (active !== o.riskScore) problems.push(`${spec.key}: signal_breakdown sums to ${active}, risk_score is ${o.riskScore}`);
  }

  for (const [key, want] of Object.entries(EXPECTED_OPEN)) {
    const d = bundle.disputes.find((x) => disputeKeyById.get(x.id!) === key);
    if (!d) {
      problems.push(`open dispute ${key} is missing`);
      continue;
    }
    if (d.status !== "open") problems.push(`${key}: status ${d.status} != open`);
    if (d.outcome !== null) problems.push(`${key}: outcome must be null`);
    if (Math.round((d.winProbability ?? 0) * 100) !== want.pct)
      problems.push(`${key}: win_probability ${d.winProbability} does not round to ${want.pct}%`);
    if (d.finalRecommendation !== want.recommendation)
      problems.push(`${key}: final_recommendation ${d.finalRecommendation} != ${want.recommendation}`);
    if (d.winLikelihoodLabel !== want.label) problems.push(`${key}: label ${d.winLikelihoodLabel} != ${want.label}`);
    if (d.deadlineOffsetHours !== want.offset) problems.push(`${key}: deadline_offset_hours ${d.deadlineOffsetHours} != ${want.offset}`);
    if (d.llmAdjustment !== 0) problems.push(`${key}: llm_adjustment must be 0`);
    if (!d.analysisComputedAt) problems.push(`${key}: analysis_computed_at must be set`);
    if (want.recommendation === "contest" && !d.draftResponse) problems.push(`${key}: contest dispute needs a draft_response`);
  }

  const tally: Record<string, number> = { won: 0, lost: 0, refunded: 0 };
  for (const d of bundle.disputes) if (d.outcome) tally[d.outcome] = (tally[d.outcome] ?? 0) + 1;
  for (const [outcome, n] of Object.entries(EXPECTED_RESOLVED))
    if (tally[outcome] !== n) problems.push(`resolved ${outcome}: ${tally[outcome]} != ${n}`);
  if (bundle.outcomes.length !== 5) problems.push(`dispute_outcomes rows: ${bundle.outcomes.length} != 5`);

  if (problems.length > 0) throw new Error(`Seed data is inconsistent with the spec:\n  - ${problems.join("\n  - ")}`);
}
