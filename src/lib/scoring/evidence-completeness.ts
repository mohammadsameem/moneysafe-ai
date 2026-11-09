/**
 * Evidence completeness (requirements REQ-EV-02, design 6.2).
 *
 * A pure function over the evidence artefacts of one order, so both the evidence assembler (M3)
 * and the dispute analysis (M2) can use it without depending on each other. No database access.
 */

/** The fields of an evidence artefact that scoring reads. A database row satisfies this. */
export interface ArtefactInput {
  artefactType: string;
  payload: unknown;
}

/** Points per artefact / sub-criterion; they sum to 100. */
export const COMPLETENESS_POINTS = Object.freeze({
  invoice_summary: 15,
  line_items: 15,
  buyer_contact: 15,
  tracking_info: 15,
  /** At least one carrier scan event is on file (any status). */
  tracking_events_present: 15,
  /** At least one scan event has status "Delivered". */
  tracking_delivered: 15,
  buyer_communication: 10,
});

export const DELIVERED_STATUS = "Delivered";

/** Every scan-event status across all `tracking_events` artefacts. Tolerates malformed payloads. */
export function trackingStatuses(artefacts: readonly ArtefactInput[]): string[] {
  const statuses: string[] = [];
  for (const artefact of artefacts) {
    if (artefact.artefactType !== "tracking_events") continue;
    const payload = artefact.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const events = (payload as { events?: unknown }).events;
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (typeof event !== "object" || event === null) continue;
      const status = (event as { status?: unknown }).status;
      if (typeof status === "string") statuses.push(status);
    }
  }
  return statuses;
}

/** Evidence completeness score, 0-100. */
export function computeEvidenceCompleteness(artefacts: readonly ArtefactInput[]): number {
  const has = (type: string) => artefacts.some((a) => a.artefactType === type);
  const statuses = trackingStatuses(artefacts);
  const p = COMPLETENESS_POINTS;
  return (
    (has("invoice_summary") ? p.invoice_summary : 0) +
    (has("line_items") ? p.line_items : 0) +
    (has("buyer_contact") ? p.buyer_contact : 0) +
    (has("tracking_info") ? p.tracking_info : 0) +
    (statuses.length > 0 ? p.tracking_events_present : 0) +
    (statuses.includes(DELIVERED_STATUS) ? p.tracking_delivered : 0) +
    (has("buyer_communication") ? p.buyer_communication : 0)
  );
}
