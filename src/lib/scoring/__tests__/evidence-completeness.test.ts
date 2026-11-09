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
