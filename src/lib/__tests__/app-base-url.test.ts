import { describe, expect, it } from "vitest";
import { getAppBaseUrl } from "../env";

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
