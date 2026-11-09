/**
 * Mark an order shipped (M3-03, design 7.2, REQ-ORD-08, REQ-EV-01).
 *
 *   1. PayPal add-tracking, only for a real (non-seed, non-demo) order when DEMO_MODE is off. A
 *      failure is a non-blocking WARNING: PayPal-side tracking helps seller protection, but it is
 *      not a precondition for our evidence.
 *   2. PayPal getOrder (falls back to the local order), the tracking events (mocked unless a real
 *      provider is configured), then the evidence artefacts.
 *   3. ONE transaction: insert the artefacts and move the order captured -> shipped with its
 *      completeness. If the order is no longer "captured" (a double click) nothing is written.
 *
 * Seeded orders are shared examples and are never shipped (see CHANGES.md).
 */
import type { NewEvidenceArtefact, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { buildShipmentArtefacts } from "@/lib/evidence/assembler";
import { PayPalError, addTracking, getOrder, withDemoFallback, type PayPalClient, type PayPalOrder } from "@/lib/paypal";
import { computeEvidenceCompleteness } from "@/lib/scoring";
import { getTrackingEvents, type TrackingDeps } from "@/lib/tracking/client";

export const CARRIERS = ["USPS", "UPS", "FEDEX", "DHL", "OTHER"] as const;

export interface ShipmentRepo {
  findVisibleOrder(orderId: string, sessionId: string): Promise<Order | null>;
  /** In ONE transaction: insert `rows`, then set status shipped + completeness WHERE status = 'captured'. False (and nothing written) if not captured. */
  completeShipment(orderId: string, rows: NewEvidenceArtefact[], completeness: number): Promise<boolean>;
}

export interface ShipDeps {
  repo: ShipmentRepo;
  paypal: PayPalClient | null;
  demoMode: boolean;
  tracking?: Omit<TrackingDeps, "demoMode" | "now">;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
}

export interface ShipRequest {
  orderId: string;
  sessionId: string;
  trackingNumber: string;
  carrier: string;
}

export type ShipResult =
  | { kind: "shipped"; completeness: number; artefacts: number; warnings: string[]; paypalTracking: "sent" | "failed" | "skipped" }
  | { kind: "not_found" }
  | { kind: "shared_example" }
  | { kind: "not_shippable"; status: Order["status"] };

/** True when the order is a real PayPal order that PayPal should hear about. */
export function isLiveOrder(order: Order, demoMode: boolean): boolean {
  return !demoMode && !order.isSeed && !order.isDemo && !!order.paypalOrderId;
}

export async function shipOrder(req: ShipRequest, deps: ShipDeps): Promise<ShipResult> {
  const now = (deps.now ?? (() => new Date()))();
  const order = await deps.repo.findVisibleOrder(req.orderId, req.sessionId);
  if (!order) return { kind: "not_found" };
  if (order.isSeed) return { kind: "shared_example" };
  if (order.sessionId !== req.sessionId) return { kind: "not_found" };
  if (order.status !== "captured") return { kind: "not_shippable", status: order.status };

  const warnings: string[] = [];
  const log = async (meta: Omit<ActivityMeta, "sessionId" | "refOrderId" | "durationMs">, startedAt: number) => {
    try {
      await deps.log?.({ sessionId: req.sessionId, refOrderId: order.id, durationMs: Date.now() - startedAt, ...meta });
    } catch {
      /* logging is best effort */
    }
  };
  const live = isLiveOrder(order, deps.demoMode);
  const carrier = req.carrier.trim();
  const trackingNumber = req.trackingNumber.trim();

  // 1. PayPal add-tracking (non-blocking).
  let paypalTracking: "sent" | "failed" | "skipped" = "skipped";
  const trackStarted = Date.now();
  if (live && deps.paypal && order.paypalOrderId && order.paypalCaptureId) {
    try {
      await addTracking(deps.paypal, order.paypalOrderId, {
        captureId: order.paypalCaptureId,
        trackingNumber,
        carrier,
        notifyPayer: false,
        requestId: `track-${order.id}`, // a retry cannot add the tracking twice
      });
      paypalTracking = "sent";
      await log({ stepType: "paypal_api", toolName: "add_tracking", inputSummary: `add tracking (${carrier})`, outputSummary: "PayPal accepted the tracking details", status: "success" }, trackStarted);
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      paypalTracking = "failed";
      warnings.push(`PayPal did not accept the tracking details (${err.message}). The evidence was still recorded.`);
      await log({ stepType: "paypal_api", toolName: "add_tracking", inputSummary: `add tracking (${carrier})`, outputSummary: err.message, status: "error" }, trackStarted);
    }
  } else if (live) {
    warnings.push("This order has no PayPal capture id, so the tracking details were not sent to PayPal. The evidence was still recorded.");
    await log({ stepType: "paypal_api", toolName: "add_tracking", inputSummary: `add tracking (${carrier})`, outputSummary: "skipped: no PayPal capture id on the order", status: "error" }, trackStarted);
  } else {
    await log(
      { stepType: "paypal_api", toolName: "add_tracking", inputSummary: `add tracking (${carrier})`, outputSummary: "simulated: demo order or Demo Mode, nothing was sent to PayPal", status: "simulated" },
      trackStarted,
    );
  }

  // 2. The PayPal order (for the invoice and line items), with the stored order as the fallback.
  let paypalOrder: PayPalOrder | null = null;
  if (order.paypalOrderId && !order.isDemo) {
    const getStarted = Date.now();
    const client = deps.paypal;
    const paypalOrderId = order.paypalOrderId;
    const fetched = await withDemoFallback<PayPalOrder | null>(client ? () => getOrder(client, paypalOrderId) : null, () => null, {
      demoMode: deps.demoMode,
      onFallback: async ({ reason, message }) =>
        log(
          { stepType: "paypal_api", toolName: "get_order", inputSummary: "read the order for the evidence", outputSummary: `Demo Mode (${reason})${message ? `: ${message}` : ""}; used the stored order`, status: "simulated" },
          getStarted,
        ),
    });
    paypalOrder = fetched.data;
    if (!fetched.isDemo) {
      await log({ stepType: "paypal_api", toolName: "get_order", inputSummary: "read the order for the evidence", outputSummary: `order ${paypalOrder?.status ?? "read"}`, status: "success" }, getStarted);
    }
  }

  // 3. Tracking events (never throws; mocked unless a real provider is configured).
  const tracking = await getTrackingEvents(
    { trackingNumber, carrier, shippedAt: now, destination: order.shippingCountry },
    { ...deps.tracking, demoMode: deps.demoMode, now: () => now },
  );

  // 4. Build, then store everything in one transaction.
  const rows = buildShipmentArtefacts({ order, paypalOrder, shipment: { trackingNumber, carrier, shippedAt: now }, tracking: tracking.result, now });
  const completeness = computeEvidenceCompleteness(rows);
  const saveStarted = Date.now();
  const done = await deps.repo.completeShipment(order.id, rows, completeness);
  if (!done) {
    const current = await deps.repo.findVisibleOrder(req.orderId, req.sessionId);
    return { kind: "not_shippable", status: current?.status ?? order.status };
  }
  await log(
    {
      stepType: "rule_engine",
      toolName: "assemble_evidence",
      inputSummary: `shipped with ${carrier}; ${rows.length} artefacts`,
      outputSummary: `evidence completeness ${completeness}%${tracking.result.isMocked ? "; scan events mocked" : ""}`,
      status: "success",
    },
    saveStarted,
  );
  return { kind: "shipped", completeness, artefacts: rows.length, warnings, paypalTracking };
}
