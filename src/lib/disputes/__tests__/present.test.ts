import { describe, expect, it } from "vitest";
import {
  LIKELIHOOD_TONE,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  REASON_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  adjustmentText,
  money,
  percent,
  sourceLabel,
} from "../present";

describe("dispute presentation", () => {
  it("labels every reason, status and outcome", () => {
    expect(REASON_LABEL).toEqual({ item_not_received: "Item not received", not_as_described: "Not as described" });
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(["action_taken", "open", "resolved_lost", "resolved_refunded", "resolved_won"]);
    expect(OUTCOME_LABEL).toEqual({ won: "Won", lost: "Lost", refunded: "Refunded" });
  });

  it("uses one colour language: green good, amber attention, red bad", () => {
    expect(OUTCOME_TONE).toEqual({ won: "good", lost: "bad", refunded: "warn" });
    expect(LIKELIHOOD_TONE).toEqual({ Strong: "good", Moderate: "warn", Weak: "bad" });
    expect(STATUS_TONE.resolved_won).toBe("good");
    expect(STATUS_TONE.resolved_lost).toBe("bad");
    expect(STATUS_TONE.open).toBe("warn");
  });

  it("names the recommendation source exactly as the spec says", () => {
    expect(sourceLabel("system")).toBe("System recommendation");
    expect(sourceLabel("ai_adjusted")).toBe("AI-adjusted recommendation");
    expect(sourceLabel(null)).toBe("System recommendation");
  });

  it("formats percentages, adjustments and money", () => {
    expect(percent(0.95)).toBe(95);
    expect(percent(0.2667)).toBe(27);
    expect(percent(0.4444)).toBe(44);
    expect(percent(1.5)).toBe(100);
    expect(percent(-1)).toBe(0);
    expect(adjustmentText(null)).toBeNull();
    expect(adjustmentText(0)).toBe("no change from the system estimate");
    expect(adjustmentText(0.05)).toBe("+5 pts from the system estimate");
    expect(adjustmentText(-0.1)).toBe("-10 pts from the system estimate");
    expect(money(145)).toBe("$145.00");
    expect(money(1234.5)).toBe("$1,234.50");
  });
});
