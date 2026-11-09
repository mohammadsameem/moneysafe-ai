/**
 * The mocked tracking provider (default). Deterministic: the same tracking number, ship time and
 * "now" always give the same events. Events only ever lie between the ship time and now, and each
 * one is labelled `isMocked: true` so the UI shows the "mocked" badge (REQ-EV-01).
 *
 * The journey: Label Created at hand-over, Picked Up after 4 h, In Transit after 28 h and 52 h,
 * Out for Delivery after 74 h and Delivered after 78 h. A tracking number ending in "X" (any case)
 * stalls In Transit forever, which demonstrates the "no Delivered scan" evidence gap.
 */
import { createHash } from "node:crypto";
import type { TrackingEvent, TrackingProvider, TrackingQuery } from "./types";

const HOUR = 3_600_000;
const HUBS = ["Charlotte, NC", "Louisville, KY", "Memphis, TN", "Chicago, IL", "Dallas, TX", "Newark, NJ", "Indianapolis, IN", "Atlanta, GA"];
export const MERCHANT_ORIGIN = "Asheville, NC";

const JOURNEY: { afterHours: number; status: TrackingEvent["status"]; where: "origin" | "hub1" | "hub2" | "destination" }[] = [
  { afterHours: 0, status: "Label Created", where: "origin" },
  { afterHours: 4, status: "Picked Up", where: "origin" },
  { afterHours: 28, status: "In Transit", where: "hub1" },
  { afterHours: 52, status: "In Transit", where: "hub2" },
  { afterHours: 74, status: "Out for Delivery", where: "destination" },
  { afterHours: 78, status: "Delivered", where: "destination" },
];

/** Two stable hub cities derived from the tracking number. */
function hubsFor(trackingNumber: string): [string, string] {
  const h = createHash("sha256").update(trackingNumber.trim().toUpperCase()).digest();
  const a = h[0]! % HUBS.length;
  const b = (a + 1 + (h[1]! % (HUBS.length - 1))) % HUBS.length;
  return [HUBS[a]!, HUBS[b]!];
}

export function stallsInTransit(trackingNumber: string): boolean {
  return /x$/i.test(trackingNumber.trim());
}

export function mockedEvents(query: TrackingQuery, now: Date): TrackingEvent[] {
  const [hub1, hub2] = hubsFor(query.trackingNumber);
  const destination = query.destination?.trim() || "Destination";
  const place = { origin: MERCHANT_ORIGIN, hub1, hub2, destination } as const;
  const stall = stallsInTransit(query.trackingNumber);

  return JOURNEY.filter((step) => !(stall && (step.status === "Out for Delivery" || step.status === "Delivered")))
    .map((step) => ({ at: query.shippedAt.getTime() + step.afterHours * HOUR, step }))
    .filter(({ at }) => at <= now.getTime())
    .map(({ at, step }) => ({ timestamp: new Date(at).toISOString(), location: place[step.where], status: step.status, isMocked: true }));
}

export const mockedProvider: TrackingProvider = {
  name: "mocked",
  getEvents: async (query, now) => mockedEvents(query, now),
};
