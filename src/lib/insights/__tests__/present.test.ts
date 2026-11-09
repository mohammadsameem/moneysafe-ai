import { describe, expect, it } from "vitest";
import { describeDelta, outcomeBars, progressText } from "../present";

describe("describeDelta: the colour is never the only signal", () => {
  it("up: an arrow, a plus sign, spoken text and an amber colour", () => {
    expect(describeDelta(3)).toEqual({ direction: "up", arrow: "\u2191", text: "+3", spoken: "up 3 from the starting value", className: "text-amber-800" });
  });

  it("down: an arrow, a real minus sign, spoken text and a blue colour", () => {
    expect(describeDelta(-2)).toEqual({ direction: "down", arrow: "\u2193", text: "\u22122", spoken: "down 2 from the starting value", className: "text-sky-800" });
  });

  it("no change is worded, not left blank", () => {
    expect(describeDelta(0)).toMatchObject({ direction: "none", text: "No change", className: "text-muted-foreground" });
  });

  it("names what it is measured against", () => {
    expect(describeDelta(3, "the current weight").spoken).toBe("up 3 from the current weight");
  });
});

describe("outcomeBars", () => {
  it("scales to the largest count, in a fixed order, with a tone each", () => {
    expect(outcomeBars({ won: 2, lost: 1, refunded: 4 })).toEqual([
      { key: "won", label: "Won", count: 2, widthPercent: 50, tone: "good" },
      { key: "lost", label: "Lost", count: 1, widthPercent: 25, tone: "bad" },
      { key: "refunded", label: "Refunded", count: 4, widthPercent: 100, tone: "warn" },
    ]);
  });

  it("with no outcomes every bar is empty (no division by zero)", () => {
    expect(outcomeBars({ won: 0, lost: 0, refunded: 0 }).map((b) => b.widthPercent)).toEqual([0, 0, 0]);
  });
});

describe("progressText", () => {
  it("says how many more until a proposal is considered", () => {
    expect(progressText({ remaining: 2, every: 5, proposalPending: false, resolved: 3 })).toBe("A new proposal is considered after every 5 resolved disputes: 2 more to go.");
  });

  it("while a proposal is pending, says no new one is requested and the count continues", () => {
    const text = progressText({ remaining: 1, every: 5, proposalPending: true, resolved: 9 });
    expect(text).toContain("waiting for your decision");
    expect(text).toContain("9 so far");
  });
});
