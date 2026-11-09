/**
 * Facts and a short text summary extracted from an order's evidence artefacts. Pure.
 *
 * Used to build the dispute prompts and the rule-based fallback text. It tolerates malformed
 * payloads (anything unexpected is skipped), and it records only COUNTS of buyer messages, never
 * their text: message bodies are untrusted and are not needed to judge or to draft a response.
 */
import { DELIVERED_STATUS, type ArtefactInput } from "../scoring";
import { evidenceGapLabels, evidenceUsedLabels } from "./labels";

export interface ScanFact {
  timestamp: string;
  status: string;
  location: string;
}

export interface EvidenceFacts {
  itemNames: string[];
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  /** Oldest first. */
  scans: ScanFact[];
  deliveredAt: string | null;
  inboundMessages: number;
  outboundMessages: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export function extractEvidenceFacts(artefacts: readonly ArtefactInput[]): EvidenceFacts {
  const facts: EvidenceFacts = {
    itemNames: [],
    carrier: null,
    trackingNumber: null,
    shippedAt: null,
    scans: [],
    deliveredAt: null,
    inboundMessages: 0,
    outboundMessages: 0,
  };

  for (const a of artefacts) {
    const payload = a.payload;
    if (!isRecord(payload)) continue;
    switch (a.artefactType) {
      case "line_items": {
        if (Array.isArray(payload.items)) {
          for (const item of payload.items) {
            const name = isRecord(item) ? str(item.name) : null;
            if (name) facts.itemNames.push(name);
          }
        }
        break;
      }
      case "tracking_info": {
        facts.trackingNumber ??= str(payload.trackingNumber);
        facts.carrier ??= str(payload.carrier);
        facts.shippedAt ??= str(payload.shippedAt);
        break;
      }
      case "tracking_events": {
        if (Array.isArray(payload.events)) {
          for (const e of payload.events) {
            if (!isRecord(e)) continue;
            const status = str(e.status);
            if (!status) continue;
            facts.scans.push({ timestamp: str(e.timestamp) ?? "", status, location: str(e.location) ?? "" });
          }
        }
        break;
      }
      case "buyer_communication": {
        if (payload.direction === "inbound") facts.inboundMessages += 1;
        else if (payload.direction === "outbound") facts.outboundMessages += 1;
        break;
      }
    }
  }

  facts.scans.sort((x, y) => x.timestamp.localeCompare(y.timestamp));
  facts.deliveredAt = [...facts.scans].reverse().find((s) => s.status === DELIVERED_STATUS)?.timestamp || null;
  return facts;
}

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "date unknown");

/** One-line-per-fact summary for a prompt's <data> section. Contains no buyer message text. */
export function describeEvidence(artefacts: readonly ArtefactInput[], completeness: number): string[] {
  const facts = extractEvidenceFacts(artefacts);
  const lines = [`Evidence completeness: ${completeness}%`];

  const used = evidenceUsedLabels([...artefacts]);
  lines.push(`On file: ${used.length > 0 ? used.join("; ") : "nothing"}`);
  const gaps = evidenceGapLabels([...artefacts]);
  lines.push(`Missing: ${gaps.length > 0 ? gaps.join("; ") : "nothing notable"}`);

  if (facts.trackingNumber) {
    lines.push(`Shipment: ${facts.carrier ?? "carrier unknown"}, tracking ${facts.trackingNumber}, shipped ${day(facts.shippedAt)}`);
  }
  if (facts.scans.length > 0) {
    lines.push(`Carrier scans (oldest first): ${facts.scans.map((s) => `${day(s.timestamp)} ${s.status}${s.location ? ` (${s.location})` : ""}`).join("; ")}`);
  }
  if (facts.inboundMessages + facts.outboundMessages > 0) {
    lines.push(`Messages with the buyer: ${facts.outboundMessages} sent by the merchant, ${facts.inboundMessages} received from the buyer`);
  }
  return lines;
}
