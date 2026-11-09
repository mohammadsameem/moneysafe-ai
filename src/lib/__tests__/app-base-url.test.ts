import { describe, expect, it } from "vitest";
import { getAppBaseUrl, getCostAssumptions } from "../env";

describe("getAppBaseUrl", () => {
  it("returns the origin: no path, query or trailing slash", () => {
    expect(getAppBaseUrl({ NEXTAUTH_URL: "https://moneysafe.example/" })).toBe("https://moneysafe.example");
    expect(getAppBaseUrl({ NEXTAUTH_URL: " http://localhost:3000/some/path?x=1 " })).toBe("http://localhost:3000");
  });

  it("throws, without echoing the value, when it is missing or not a URL", () => {
    expect(() => getAppBaseUrl({})).toThrow(/NEXTAUTH_URL/);
    expect(() => getAppBaseUrl({ NEXTAUTH_URL: "" })).toThrow(/NEXTAUTH_URL/);
    expect(() => getAppBaseUrl({ NEXTAUTH_URL: "not-a-url-secret" })).toThrow(/NEXTAUTH_URL/);
    try {
      getAppBaseUrl({ NEXTAUTH_URL: "not-a-url-secret" });
    } catch (err) {
      expect(String(err)).not.toContain("not-a-url-secret");
    }
  });
});

describe("getCostAssumptions", () => {
  it("defaults to a $20 chargeback fee and $10 contest effort", () => {
    expect(getCostAssumptions({})).toEqual({ chargebackFeeUsd: 20, contestEffortUsd: 10 });
    expect(getCostAssumptions({ CHARGEBACK_FEE_USD: "  ", CONTEST_EFFORT_USD: "" })).toEqual({ chargebackFeeUsd: 20, contestEffortUsd: 10 });
  });

  it("reads overrides, including zero", () => {
    expect(getCostAssumptions({ CHARGEBACK_FEE_USD: "25.5", CONTEST_EFFORT_USD: "0" })).toEqual({ chargebackFeeUsd: 25.5, contestEffortUsd: 0 });
  });

  it("throws a message that names the variable but not the value", () => {
    for (const bad of ["abc", "-1", "Infinity"]) {
      const err = (() => {
        try {
          getCostAssumptions({ CHARGEBACK_FEE_USD: bad });
        } catch (e) {
          return String(e);
        }
        return "";
      })();
      expect(err).toContain("CHARGEBACK_FEE_USD");
      expect(err).not.toContain(bad);
    }
  });
});
