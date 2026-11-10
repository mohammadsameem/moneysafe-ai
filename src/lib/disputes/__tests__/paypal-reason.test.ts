import { describe, expect, it } from "vitest";
import { allowedActions, formatIngestedBuyerMessage, isRealDispute, liveBlockReason, mapPayPalReason, paypalReasonNote, type LiveDisputeInfo } from "../paypal-reason";

/** The exact `allowed_response_options` PayPal's sandbox returned for the first real dispute (inquiry stage). */
const SANDBOX_OPTIONS = { accept_claim: { accept_claim_types: ["PARTIAL_REFUND", "REFUND"] }, make_offer: { offer_types: ["REFUND"] } };

describe("mapPayPalReason", () => {
  it("maps the two reasons the app models exactly", () => {
    expect(mapPayPalReason("MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).toEqual({ reason: "item_not_received", exact: true });
    expect(mapPayPalReason("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")).toEqual({ reason: "not_as_described", exact: true });
  });

  it("maps any other reason to the closest supported one and says it is not exact", () => {
    for (const code of ["UNAUTHORISED", "DUPLICATE", "CREDIT_NOT_PROCESSED", "INCORRECT_AMOUNT", "SOMETHING_NEW", undefined, null]) {
      expect(mapPayPalReason(code)).toEqual({ reason: "item_not_received", exact: false });
    }
  });
});

describe("the real reason travels with the dispute", () => {
  it("an exact reason: PayPal's code first, then the buyer's words, and a plain note for the analysis", () => {
    const text = formatIngestedBuyerMessage("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "the product is not delivered");
    expect(text).toBe('PayPal reason: MERCHANDISE_OR_SERVICE_NOT_RECEIVED\nBuyer wrote: the product is not delivered');
    expect(paypalReasonNote(text)).toBe("PayPal reports this dispute with the reason MERCHANDISE_OR_SERVICE_NOT_RECEIVED.");
  });

  it("a reason the app does not model: the text and the analysis note both say it was mapped", () => {
    const text = formatIngestedBuyerMessage("UNAUTHORISED", null);
    expect(text).toContain("PayPal reason: UNAUTHORISED");
    expect(text).toContain('analyses it as "item not received"');
    expect(paypalReasonNote(text)).toBe('PayPal reports this dispute with the reason UNAUTHORISED. The app does not model that reason exactly, so it is analysed as "item not received", the closest supported reason.');
  });

  it("other disputes (seeded, simulated) get no note", () => {
    expect(paypalReasonNote("It never arrived.")).toBeNull();
    expect(paypalReasonNote(null)).toBeNull();
  });
});

describe("allowedActions (fails closed)", () => {
  it("the real sandbox options allow a refund and nothing else this app can send", () => {
    expect(allowedActions(SANDBOX_OPTIONS)).toEqual(["accept_claim"]);
  });

  it("evidence is allowed only when PayPal lists provide_evidence", () => {
    expect(allowedActions({ ...SANDBOX_OPTIONS, provide_evidence: {} })).toEqual(["submit_evidence", "accept_claim"]);
    expect(allowedActions({ provide_evidence: {} })).toEqual(["submit_evidence"]);
  });

  it("a refund is allowed only if REFUND is among the accept types", () => {
    expect(allowedActions({ accept_claim: { accept_claim_types: ["PARTIAL_REFUND"] } })).toEqual([]);
    expect(allowedActions({ accept_claim: {} })).toEqual([]);
  });

  it("anything unrecognised, empty or malformed allows nothing", () => {
    for (const v of [undefined, null, [], "accept_claim", 7, {}, { make_offer: {} }, { accept_claim: "yes" }]) expect(allowedActions(v)).toEqual([]);
  });
});

describe("liveBlockReason", () => {
  const live = (over: Partial<LiveDisputeInfo> = {}): LiveDisputeInfo => ({
    paypalDisputeId: "PP-R-1", reasonCode: null, status: "WAITING_FOR_SELLER_RESPONSE", state: "REQUIRED_ACTION", stage: "INQUIRY", dueDate: null, allowed: ["accept_claim"], readFailed: null, ...over,
  });

  it("is null when PayPal allows the action", () => {
    expect(liveBlockReason(live(), "accept_claim")).toBeNull();
  });

  it("names the stage and what PayPal does allow when the recommended action is not allowed", () => {
    const reason = liveBlockReason(live(), "submit_evidence")!;
    expect(reason).toContain("does not currently allow you to submit evidence");
    expect(reason).toContain("INQUIRY");
    expect(reason).toContain("accept the claim (refund)");
    expect(reason).toContain("No action is offered");
  });

  it("says plainly when PayPal allows nothing this app can send", () => {
    expect(liveBlockReason(live({ allowed: [] }), "accept_claim")).toContain("lists no response this app can send");
  });

  it("blocks everything while PayPal cannot be read", () => {
    expect(liveBlockReason(live({ readFailed: "PayPal could not be read right now.", allowed: ["accept_claim"] }), "accept_claim")).toContain("could not be read");
  });
});

describe("isRealDispute", () => {
  it("is true only for a linked, non-seed, non-demo dispute", () => {
    expect(isRealDispute({ isSeed: false, isDemo: false, paypalDisputeId: "PP-R-1" })).toBe(true);
    expect(isRealDispute({ isSeed: false, isDemo: false, paypalDisputeId: null })).toBe(false);
    expect(isRealDispute({ isSeed: false, isDemo: true, paypalDisputeId: "PP-R-1" })).toBe(false);
    expect(isRealDispute({ isSeed: true, isDemo: false, paypalDisputeId: "PP-R-1" })).toBe(false);
  });
});
