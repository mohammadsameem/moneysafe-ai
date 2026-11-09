import { describe, expect, it } from "vitest";
import { computeEvidenceCompleteness } from "../evidence-completeness";
import { FULL_DELIVERED, FULL_IN_TRANSIT, FULL_NO_EVENTS } from "./fixtures";

describe("computeEvidenceCompleteness", () => {
  it("full artefacts with a Delivered scan score 100", () => {
    expect(computeEvidenceCompleteness(FULL_DELIVERED)).toBe(100);
  });

  it("full artefacts but scans stop at In Transit score 85 (missing the Delivered 15)", () => {
    expect(computeEvidenceCompleteness(FULL_IN_TRANSIT)).toBe(85);
  });

  it("full artefacts without any tracking events score 70 (missing events 15 and Delivered 15)", () => {
    expect(computeEvidenceCompleteness(FULL_NO_EVENTS)).toBe(70);
  });

  it("no artefacts score 0", () => {
    expect(computeEvidenceCompleteness([])).toBe(0);
  });
});

describe("completenessBreakdown", () => {
  it("lists the seven REQ-EV-02 criteria in order, with the tracking artefact split in two, summing to 100", async () => {
    const { completenessBreakdown, COMPLETENESS_POINTS } = await import("../evidence-completeness");
    const items = completenessBreakdown([]);
    expect(items.map((i) => i.criterion)).toEqual([
      "invoice_summary", "line_items", "buyer_contact", "tracking_info", "tracking_events_present", "tracking_delivered", "buyer_communication",
    ]);
    expect(items.reduce((s, i) => s + i.max, 0)).toBe(100);
    expect(items.every((i) => !i.met && i.points === 0)).toBe(true);
    expect(Object.values(COMPLETENESS_POINTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("agrees with computeEvidenceCompleteness for every fixture", async () => {
    const { completenessBreakdown } = await import("../evidence-completeness");
    const { FOUR_BASICS, FULL_DELIVERED, FULL_IN_TRANSIT, FULL_NO_EVENTS, SEED_E_EVIDENCE } = await import("./fixtures");
    for (const set of [[], FOUR_BASICS, FULL_DELIVERED, FULL_IN_TRANSIT, FULL_NO_EVENTS, SEED_E_EVIDENCE]) {
      expect(completenessBreakdown(set).reduce((s, i) => s + i.points, 0)).toBe(computeEvidenceCompleteness(set));
    }
    const transit = completenessBreakdown(FULL_IN_TRANSIT);
    expect(transit.find((i) => i.criterion === "tracking_events_present")?.met).toBe(true);
    expect(transit.find((i) => i.criterion === "tracking_delivered")?.met).toBe(false);
  });
});
