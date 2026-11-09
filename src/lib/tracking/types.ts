import { z } from "zod";

/** Carrier scan statuses the app understands. `computeEvidenceCompleteness` looks for "Delivered". */
export const SCAN_STATUSES = ["Label Created", "Picked Up", "In Transit", "Out for Delivery", "Delivered", "Exception"] as const;

/** One carrier scan event, exactly as stored in a `tracking_events` artefact. */
export const TrackingEventSchema = z.object({
  /** ISO-8601 UTC. */
  timestamp: z.string().datetime(),
  location: z.string().max(120),
  status: z.enum(SCAN_STATUSES),
  /** True when the event did not come from a real carrier (REQ-EV-01: labelled "mocked"). */
  isMocked: z.boolean(),
});
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

export const TrackingResultSchema = z.object({
  events: z.array(TrackingEventSchema).max(100),
  /** Which provider answered, e.g. "mocked". Never a key or URL. */
  provider: z.string().min(1).max(40),
  isMocked: z.boolean(),
});
export type TrackingResult = z.infer<typeof TrackingResultSchema>;

export interface TrackingQuery {
  trackingNumber: string;
  carrier: string;
  /** When the parcel was handed over; events never start before it. */
  shippedAt: Date;
  /** Where it is going (city or country), for the event locations. */
  destination?: string;
}

/**
 * A tracking provider. A real one (AfterShip, TrackingMore, ...) would implement this; the app
 * ships with the mocked provider only (see CHANGES.md).
 */
export interface TrackingProvider {
  name: string;
  getEvents(query: TrackingQuery, now: Date): Promise<TrackingEvent[]>;
}
