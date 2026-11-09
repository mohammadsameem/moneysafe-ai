import { describe, expect, it } from "vitest";
import { ACCEPT_CLAIM_NOTE, EVIDENCE_NOTES_MAX_CHARS, buildProvideEvidencePayload, type EvidenceArtefactLike } from "../evidence-payload";

const tracking = (over: Record<string, unknown> = {}): EvidenceArtefactLike => ({
  artefactType: "tracking_info",
  payload: { trackingNumber: "9400111899223197428490", carrier: "USPS", shippedAt: "2026-11-01T08:00:00.000Z", ...over },
});
const DRAFT = "Hello PayPal Dispute Team,\n\nThe parcel was delivered.\n\nThank you,\n[Your name]";

const ok = (r: ReturnType<typeof buildProvideEvidencePayload>) => {
  if (!r.ok) throw new Error(`expected a payload, got ${r.code}`);
  return r.payload;
};

describe("buildProvideEvidencePayload: the three branches", () => {
  it("item_not_received -> PROOF_OF_FULFILLMENT with the tracking info, notes and the shipment date", () => {
    const payload = ok(buildProvideEvidencePayload({ reason: "item_not_received" }, DRAFT, [tracking()]));
    expect(payload).toEqual({
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: { tracking_info: [{ carrier_name: "USPS", tracking_number: "9400111899223197428490" }] },
          notes: DRAFT,
          date: "2026-11-01T08:00:00.000Z",
        },
      ],
    });
  });

  it("not_as_described, no document -> DECLARATION with notes only (never proof of fulfillment, never photos)", () => {
    const payload = ok(buildProvideEvidencePayload({ reason: "not_as_described" }, DRAFT, [tracking()]));
    expect(payload).toEqual({ evidences: [{ evidence_type: "DECLARATION", notes: DRAFT }] });
    expect(JSON.stringify(payload)).not.toMatch(/PROOF_OF_FULFILLMENT|PHOTOS_OF_SHIPPED_ITEM|evidence_info|documents/);
  });

  it("not_as_described, with a document -> PHOTOS_OF_SHIPPED_ITEM with documents[] and notes", () => {
    const payload = ok(buildProvideEvidencePayload({ reason: "not_as_described" }, DRAFT, [tracking()], [{ name: "item.jpg" }, { name: "box.jpg" }]));
    expect(payload).toEqual({ evidences: [{ evidence_type: "PHOTOS_OF_SHIPPED_ITEM", documents: [{ name: "item.jpg" }, { name: "box.jpg" }], notes: DRAFT }] });
  });
});

describe("buildProvideEvidencePayload: the combinations PayPal rejects can never be produced", () => {
  const reasons = ["item_not_received", "not_as_described"] as const;
  const docSets = [[], [{ name: "a.jpg" }]];
  const artefactSets: EvidenceArtefactLike[][] = [[], [tracking()]];

  it("across every reason x documents x tracking combination", () => {
    for (const reason of reasons) {
      for (const documents of docSets) {
        for (const artefacts of artefactSets) {
          const result = buildProvideEvidencePayload({ reason }, DRAFT, artefacts, documents);
          if (!result.ok) {
            expect(result.code, `${reason}`).toBe("missing_tracking");
            expect(reason).toBe("item_not_received"); // only an INR claim needs tracking
            continue;
          }
          const ev = result.payload.evidences[0]!;
          if (reason === "not_as_described") expect(ev.evidence_type).not.toBe("PROOF_OF_FULFILLMENT");
          if (reason === "item_not_received") expect(ev.evidence_type).toBe("PROOF_OF_FULFILLMENT");
          if (ev.evidence_type === "PHOTOS_OF_SHIPPED_ITEM") {
            expect(reason).toBe("not_as_described");
            expect(ev.documents?.length ?? 0).toBeGreaterThan(0); // never photos without a document
          }
          if (ev.evidence_type === "DECLARATION") expect(documents).toHaveLength(0);
        }
      }
    }
  });
});

describe("buildProvideEvidencePayload: carriers and tracking", () => {
  const carrier = (c: string) => ok(buildProvideEvidencePayload({ reason: "item_not_received" }, DRAFT, [tracking({ carrier: c })])).evidences[0]!.evidence_info!.tracking_info[0]!;

  it("maps known carriers case-insensitively", () => {
    expect(carrier("ups").carrier_name).toBe("UPS");
    expect(carrier("FedEx").carrier_name).toBe("FEDEX");
    expect(carrier("Usps").carrier_name).toBe("USPS");
    expect(carrier("dhl").carrier_name).toBe("DHL");
  });

  it("sends an unknown carrier as OTHER with its name, capped", () => {
    expect(carrier("Pigeon Post")).toMatchObject({ carrier_name: "OTHER", carrier_name_other: "Pigeon Post" });
    expect(carrier("x".repeat(200)).carrier_name_other).toHaveLength(64);
  });

  it("never sends a tracking URL, and omits the date when shippedAt is missing or invalid", () => {
    for (const shippedAt of [undefined, "not a date", ""]) {
      const ev = ok(buildProvideEvidencePayload({ reason: "item_not_received" }, DRAFT, [tracking({ shippedAt })])).evidences[0]!;
      expect(ev).not.toHaveProperty("date");
      expect(JSON.stringify(ev)).not.toContain("tracking_url");
    }
  });

  it("an item_not_received claim without usable tracking is refused, not sent half-empty", () => {
    for (const artefacts of [[], [{ artefactType: "invoice_summary", payload: {} }], [tracking({ trackingNumber: "" })], [tracking({ carrier: null })], [{ artefactType: "tracking_info", payload: "junk" }]]) {
      const r = buildProvideEvidencePayload({ reason: "item_not_received" }, DRAFT, artefacts);
      expect(r).toMatchObject({ ok: false, code: "missing_tracking" });
    }
  });

  it("takes the first usable tracking_info and ignores unusable ones before it", () => {
    const payload = ok(buildProvideEvidencePayload({ reason: "item_not_received" }, DRAFT, [{ artefactType: "tracking_info", payload: {} }, tracking()]));
    expect(payload.evidences[0]!.evidence_info!.tracking_info[0]!.tracking_number).toBe("9400111899223197428490");
  });
});

describe("buildProvideEvidencePayload: the notes", () => {
  it("rejects an empty or whitespace-only response", () => {
    for (const draft of ["", "   ", "\n\n"]) expect(buildProvideEvidencePayload({ reason: "not_as_described" }, draft, [])).toMatchObject({ ok: false, code: "empty_draft" });
  });

  it("accepts exactly 2000 characters and refuses 2001", () => {
    expect(EVIDENCE_NOTES_MAX_CHARS).toBe(2000);
    expect(buildProvideEvidencePayload({ reason: "not_as_described" }, "x".repeat(2000), []).ok).toBe(true);
    expect(buildProvideEvidencePayload({ reason: "not_as_described" }, "x".repeat(2001), [])).toMatchObject({ ok: false, code: "draft_too_long" });
  });

  it("trims and normalises Windows line endings", () => {
    const payload = ok(buildProvideEvidencePayload({ reason: "not_as_described" }, "  Line one\r\nLine two  \r\n", []));
    expect(payload.evidences[0]!.notes).toBe("Line one\nLine two");
  });
});

describe("accept-claim note", () => {
  it("is fixed text, so accepting a claim needs no merchant-written content", () => {
    expect(ACCEPT_CLAIM_NOTE.length).toBeGreaterThan(10);
    expect(ACCEPT_CLAIM_NOTE.length).toBeLessThan(2000);
  });
});
