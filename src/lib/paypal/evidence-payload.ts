/**
 * Builds the PayPal provide-evidence body (design 4.5, REQ-DIS-09). Pure.
 *
 *   item_not_received -> PROOF_OF_FULFILLMENT with the tracking info on file
 *   not_as_described  -> DECLARATION with notes (the default: the demo has no document upload)
 *                        PHOTOS_OF_SHIPPED_ITEM only when at least one document is attached
 *
 * PayPal rejects PROOF_OF_FULFILLMENT for a not-as-described claim, and PHOTOS_OF_SHIPPED_ITEM
 * without a document, so neither combination can be produced here.
 */
import type { ProvideEvidencePayload } from "./disputes";

/** PayPal's `notes` field limit. */
export const EVIDENCE_NOTES_MAX_CHARS = 2000;

/** The fields of an evidence artefact this reads. A database row satisfies this. */
export interface EvidenceArtefactLike {
  artefactType: string;
  payload: unknown;
}

export type EvidencePayloadResult =
  | { ok: true; payload: ProvideEvidencePayload }
  | { ok: false; code: "empty_draft" | "draft_too_long" | "missing_tracking"; message: string };

type PayPalCarrier = "UPS" | "FEDEX" | "USPS" | "DHL" | "OTHER";
const KNOWN_CARRIERS: Readonly<Record<string, PayPalCarrier>> = { UPS: "UPS", FEDEX: "FEDEX", USPS: "USPS", DHL: "DHL" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function trackingFrom(artefacts: readonly EvidenceArtefactLike[]): { carrier: string; trackingNumber: string; shippedAt: string | null } | null {
  for (const a of artefacts) {
    if (a.artefactType !== "tracking_info" || !isRecord(a.payload)) continue;
    const trackingNumber = text(a.payload.trackingNumber);
    const carrier = text(a.payload.carrier);
    if (trackingNumber && carrier) return { carrier, trackingNumber, shippedAt: text(a.payload.shippedAt) };
  }
  return null;
}

export function buildProvideEvidencePayload(
  dispute: { reason: "item_not_received" | "not_as_described" },
  draft: string,
  artefacts: readonly EvidenceArtefactLike[],
  documents: readonly { name: string }[] = [],
): EvidencePayloadResult {
  const notes = draft.replace(/\r\n/g, "\n").trim();
  if (notes === "") return { ok: false, code: "empty_draft", message: "The response is empty." };
  if (notes.length > EVIDENCE_NOTES_MAX_CHARS) {
    return { ok: false, code: "draft_too_long", message: `The response is ${notes.length} characters; PayPal accepts at most ${EVIDENCE_NOTES_MAX_CHARS}.` };
  }

  if (dispute.reason === "item_not_received") {
    const tracking = trackingFrom(artefacts);
    if (!tracking) {
      return { ok: false, code: "missing_tracking", message: "No tracking number and carrier are on file, so proof of fulfillment cannot be submitted." };
    }
    const code = KNOWN_CARRIERS[tracking.carrier.toUpperCase()];
    const shipped = tracking.shippedAt && !Number.isNaN(new Date(tracking.shippedAt).getTime()) ? new Date(tracking.shippedAt).toISOString() : undefined;
    return {
      ok: true,
      payload: {
        evidences: [
          {
            evidence_type: "PROOF_OF_FULFILLMENT",
            evidence_info: {
              tracking_info: [
                {
                  carrier_name: code ?? "OTHER",
                  ...(code ? {} : { carrier_name_other: tracking.carrier.slice(0, 64) }),
                  tracking_number: tracking.trackingNumber,
                },
              ],
            },
            notes,
            ...(shipped ? { date: shipped } : {}),
          },
        ],
      },
    };
  }

  // not_as_described
  if (documents.length > 0) {
    return { ok: true, payload: { evidences: [{ evidence_type: "PHOTOS_OF_SHIPPED_ITEM", documents: documents.map((d) => ({ name: d.name })), notes }] } };
  }
  return { ok: true, payload: { evidences: [{ evidence_type: "DECLARATION", notes }] } };
}

/** The accept-claim body. The note is fixed text: accepting a claim needs no merchant-written content. */
export const ACCEPT_CLAIM_NOTE = "The merchant accepts the claim and will refund the buyer in full.";
