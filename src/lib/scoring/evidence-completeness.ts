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

export type CompletenessCriterion = keyof typeof COMPLETENESS_POINTS;

export const CRITERION_LABEL: Readonly<Record<CompletenessCriterion, string>> = Object.freeze({
  invoice_summary: "Invoice / order summary",
  line_items: "Order line items",
  buyer_contact: "Buyer contact details",
  tracking_info: "Tracking number + carrier",
  tracking_events_present: "Tracking scan events present",
  tracking_delivered: "Scan events include \"Delivered\"",
  buyer_communication: "Buyer communications",
});

export interface CompletenessItem {
  criterion: CompletenessCriterion;
  label: string;
  met: boolean;
  points: number;
  max: number;
}

/** Each criterion of REQ-EV-02, in order, with whether it is met. The tracking artefact is split in two. */
export function completenessBreakdown(artefacts: readonly ArtefactInput[]): CompletenessItem[] {
  const has = (type: string) => artefacts.some((a) => a.artefactType === type);
  const statuses = trackingStatuses(artefacts);
  const met: Record<CompletenessCriterion, boolean> = {
    invoice_summary: has("invoice_summary"),
    line_items: has("line_items"),
    buyer_contact: has("buyer_contact"),
    tracking_info: has("tracking_info"),
    tracking_events_present: statuses.length > 0,
    tracking_delivered: statuses.includes(DELIVERED_STATUS),
    buyer_communication: has("buyer_communication"),
  };
  return (Object.keys(COMPLETENESS_POINTS) as CompletenessCriterion[]).map((criterion) => ({
    criterion,
    label: CRITERION_LABEL[criterion],
    met: met[criterion],
    points: met[criterion] ? COMPLETENESS_POINTS[criterion] : 0,
    max: COMPLETENESS_POINTS[criterion],
  }));
}

/** Evidence completeness score, 0-100. */
export function computeEvidenceCompleteness(artefacts: readonly ArtefactInput[]): number {
  return completenessBreakdown(artefacts).reduce((sum, item) => sum + item.points, 0);
}
