/**
 * A dispute response is plain text. The app cannot attach files to it, so no draft may claim to. This guards every source
 * of draft text: the seeded drafts, the rule-based template, the prompt, and what a model is allowed to return.
 */
import { describe, expect, it } from "vitest";
import { buildSeedBundle } from "@/seed/data";
import { buildDraftResponsePrompt } from "../prompts";
import { ruleBasedDraftResponse } from "../rule-based";
import { ATTACHMENT_CLAIM, DraftResponseSchema } from "../schemas";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const ATTACHED = /attach/i;

describe("no draft claims an attachment", () => {
  it("none of the seeded dispute drafts contains 'attached' (any case)", () => {
    const drafts = buildSeedBundle(NOW).disputes.map((d) => d.draftResponse).filter((t): t is string => Boolean(t));
    expect(drafts.length).toBeGreaterThanOrEqual(2); // SEED-C and SEED-E are the contest drafts
    for (const text of drafts) {
      expect(text).not.toMatch(ATTACHED);
      expect(text).not.toMatch(ATTACHMENT_CLAIM);
    }
  });

  it("the seeded drafts say what is on file instead", () => {
    const text = buildSeedBundle(NOW).disputes.map((d) => d.draftResponse ?? "").join("\n");
    expect(text).toContain("The evidence on file includes the invoice, line items");
    expect(text.match(/The evidence on file includes/g)).toHaveLength(2);
  });

  it("the rule-based template never says 'attached', for every reason and every amount of evidence", () => {
    const base = { itemName: "Stoneware dinner set", amountUsd: 145, carrier: "USPS", shippedOn: "1 Nov 2026" };
    const cases = [
      { reason: "item_not_received" as const, trackingNumber: "9400111899223197428490", lastScan: null, deliveredOn: "5 Nov 2026" },
      { reason: "item_not_received" as const, trackingNumber: "9400111899223197428490", lastScan: { status: "In Transit", date: "4 Nov 2026" }, deliveredOn: null },
      { reason: "item_not_received" as const, trackingNumber: null, lastScan: null, deliveredOn: null },
      { reason: "not_as_described" as const, trackingNumber: null, lastScan: null, deliveredOn: null },
    ];
    for (const c of cases) {
      const text = ruleBasedDraftResponse({ ...base, ...c });
      expect(text).not.toMatch(ATTACHED);
      expect(text.startsWith("Hello PayPal Dispute Team,")).toBe(true);
    }
    expect(ruleBasedDraftResponse({ ...base, ...cases[0]! })).toContain("The evidence on file includes the invoice, line items, delivery address and tracking details.");
  });

  it("the prompt tells the model it cannot attach files and gives it the safe wording", () => {
    const prompt = buildDraftResponsePrompt({ reason: "item_not_received", amountUsd: 145, buyerMessage: null, lineItemNames: ["Dinner set"], evidenceLines: ["Tracking number on file."] });
    expect(prompt).toContain("you cannot add files");
    expect(prompt).toContain("The evidence on file includes");
    expect(prompt).toContain("never write that anything is enclosed, uploaded or sent");
  });
});

describe("a model draft that claims an attachment is rejected", () => {
  const ok = "Hello PayPal Dispute Team,\n\nThe evidence on file includes the invoice and the tracking record.\n\nThank you,\n[Your name]";

  it("accepts a clean draft", () => {
    expect(DraftResponseSchema.safeParse({ response_text: ok }).success).toBe(true);
  });

  it("rejects the usual ways of claiming an attachment", () => {
    for (const bad of [
      "I have attached the invoice and tracking record.",
      "Please find the invoice attached.",
      "Attached is the tracking record.",
      "See the attached screenshots.",
      "The invoice is enclosed with this response.",
      "I am enclosing the receipt.",
      "Attachments: invoice.pdf",
      "I ATTACHED everything.",
    ]) {
      const result = DraftResponseSchema.safeParse({ response_text: `Hello PayPal Dispute Team,\n\n${bad}\n\nThank you,\n[Your name]` });
      expect(result.success, bad).toBe(false);
    }
  });

  it("does not reject words that merely contain the letters", () => {
    // Word boundaries: look-alikes that contain the letters but are not the word.
    for (const fine of ["The detached garage is not part of this order.", "The label was reattached by the carrier before scanning.", "An unattached accessory was listed separately."]) {
      expect(ATTACHMENT_CLAIM.test(fine), fine).toBe(false);
    }
  });
});
