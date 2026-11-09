import { describe, expect, it } from "vitest";
import { signalDetail } from "../signal-detail";

describe("signalDetail", () => {
  it("shows the threshold behind the relative-value signal (the SEED-F case: $320 > 3 x $85 = $255)", () => {
    expect(signalDetail("high_relative_value", 320, 85)).toBe("$320.00 > 3 \u00d7 $85.00 usual order = $255.00");
  });

  it("shows the first-time-buyer threshold (the SEED-B case)", () => {
    expect(signalDetail("first_time_high_value", 210, 85)).toBe("$210.00 > $200.00 for a first-time buyer");
  });

  it("has nothing to add for signals that are not about an amount", () => {
    for (const s of ["country_mismatch", "rush_shipping", "disposable_email", "repeated_attempts", "unknown"]) expect(signalDetail(s, 100, 85)).toBeNull();
  });

  it("follows the merchant baseline", () => {
    expect(signalDetail("high_relative_value", 500, 100)).toBe("$500.00 > 3 \u00d7 $100.00 usual order = $300.00");
  });
});
