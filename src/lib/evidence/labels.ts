/**
 * Plain-English labels for the evidence an order has, and the gaps it has (REQ-DIS-03).
 *
 * One implementation, used by the seed (so the seeded analyses read the same as live ones) and by
 * the dispute analysis (as the rule-based fallback for the model's evidence_used / evidence_gaps).
 * Pure: no database access.
 */
import { DELIVERED_STATUS, trackingStatuses, type ArtefactInput } from "../scoring";

export function evidenceUsedLabels(arts: ArtefactInput[]): string[] {
  const statuses = trackingStatuses(arts);
  const has = (t: string) => arts.some((a) => a.artefactType === t);
  const labels: string[] = [];
  if (has("invoice_summary")) labels.push("Invoice / order summary");
  if (has("line_items")) labels.push("Order line items");
  if (has("buyer_contact")) labels.push("Buyer contact details");
  if (has("tracking_info")) labels.push("Tracking number and carrier");
  if (statuses.length > 0) {
    labels.push(
      statuses.includes(DELIVERED_STATUS)
        ? "Carrier scan history ending in Delivered (mocked)"
        : "Carrier scan history, In Transit only (mocked)",
    );
  }
  if (has("buyer_communication")) labels.push("Buyer communications");
  return labels;
}

export function evidenceGapLabels(arts: ArtefactInput[]): string[] {
  const statuses = trackingStatuses(arts);
  const gaps: string[] = [];
  if (statuses.length === 0) gaps.push("No carrier scan events on file");
  else if (!statuses.includes(DELIVERED_STATUS)) gaps.push("No Delivered scan: tracking stops at In Transit");
  if (!arts.some((a) => a.artefactType === "buyer_communication")) gaps.push("No buyer communications on file");
  return gaps;
}
