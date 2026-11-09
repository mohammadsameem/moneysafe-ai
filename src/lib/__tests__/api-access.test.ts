import { describe, expect, it } from "vitest";
import { isOpenApiPath } from "../api-access";
import { sessionCookieName, shouldUseSecureCookies } from "../session-cookie";

describe("isOpenApiPath", () => {
  it.each(["/api/demo/status", "/api/demo/status/", "/api/auth", "/api/auth/", "/api/auth/session", "/api/auth/callback/credentials", "/api/auth/csrf"])(
    "leaves %s open",
    (path) => expect(isOpenApiPath(path)).toBe(true),
  );

  it.each([
    "/api/orders",
    "/api/orders/paypal-return",
    "/api/orders/paypal-cancel",
    "/api/demo",
    "/api/demo/status/extra",
    "/api/demo/statusx",
    "/api/authx",
    "/api/auth-bypass",
    "/api/Demo/status",
    "/api/AUTH/session",
    "/api",
    "/",
    "/api//demo/status",
  ])("requires a session for %s", (path) => expect(isOpenApiPath(path)).toBe(false));
});

describe("session cookie naming", () => {
  it("is secure exactly when the app URL is https", () => {
    expect(shouldUseSecureCookies("https://moneysafe.example")).toBe(true);
    expect(shouldUseSecureCookies(" HTTPS://moneysafe.example ")).toBe(true);
    expect(shouldUseSecureCookies("http://localhost:3000")).toBe(false);
    expect(shouldUseSecureCookies(undefined)).toBe(false);
    expect(shouldUseSecureCookies("")).toBe(false);
  });

  it("uses the __Secure- prefix only for secure cookies", () => {
    expect(sessionCookieName("https://x.example")).toBe("__Secure-next-auth.session-token");
    expect(sessionCookieName("http://localhost:3000")).toBe("next-auth.session-token");
  });
});
