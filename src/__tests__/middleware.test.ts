import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getToken = vi.fn();
vi.mock("next-auth/jwt", () => ({ getToken: (...args: unknown[]) => getToken(...args) }));

import { config, middleware } from "../middleware";

const request = (path: string) => new NextRequest(`https://moneysafe.test${path}`);
/** NextResponse.next() marks itself with this header; anything else is a response we produced. */
const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("middleware: API session protection", () => {
  beforeEach(() => {
    getToken.mockReset();
    process.env.NEXTAUTH_SECRET = "test-secret-test-secret";
    process.env.NEXTAUTH_URL = "https://moneysafe.test";
  });

  it("only runs on /api routes", () => {
    expect(config.matcher).toEqual(["/api/:path*"]);
  });

  it.each(["/api/demo/status", "/api/auth/session", "/api/auth/callback/credentials"])(
    "lets %s through without looking at a session",
    async (path) => {
      const res = await middleware(request(path));
      expect(passedThrough(res)).toBe(true);
      expect(getToken).not.toHaveBeenCalled();
    },
  );

  it.each(["/api/orders", "/api/orders/22222222-2222-4222-8222-222222222222", "/api/anything-else"])(
    "returns 401 JSON for %s without a session",
    async (path) => {
      getToken.mockResolvedValue(null);
      const res = await middleware(request(path));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    },
  );

  it.each([
    "/api/orders/paypal-return?token=ABC&PayerID=XYZ",
    "/api/orders/paypal-return",
    "/api/orders/paypal-cancel?token=ABC",
    "/api/orders/paypal-cancel/",
  ])("redirects (302) %s to /login without a session, instead of returning JSON", async (path) => {
    getToken.mockResolvedValue(null);
    const res = await middleware(request(path));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://moneysafe.test/login");
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  it("also redirects those routes when the token has no usable session id", async () => {
    getToken.mockResolvedValue({ sub: "demo-merchant" });
    expect((await middleware(request("/api/orders/paypal-return?token=ABC"))).status).toBe(302);
  });

  it("only those two routes redirect: look-alikes and sub-paths still get 401 JSON", async () => {
    getToken.mockResolvedValue(null);
    for (const path of ["/api/orders/paypal-return/extra", "/api/orders/paypal-returnx", "/api/orders/PAYPAL-RETURN", "/api/orders/paypal-return-x/cancel"]) {
      expect((await middleware(request(path))).status, path).toBe(401);
    }
  });

  it("lets those two routes through with a valid session", async () => {
    getToken.mockResolvedValue({ sid: "sid-1" });
    expect(passedThrough(await middleware(request("/api/orders/paypal-return?token=ABC")))).toBe(true);
    expect(passedThrough(await middleware(request("/api/orders/paypal-cancel?token=ABC")))).toBe(true);
  });

  it("lets a request with a valid session (one that carries a session id) through", async () => {
    getToken.mockResolvedValue({ sid: "sid-1", sub: "demo-merchant" });
    expect(passedThrough(await middleware(request("/api/orders")))).toBe(true);
  });

  it.each([{}, { sid: "" }, { sid: 5 }])("rejects a token without a usable session id: %j", async (token) => {
    getToken.mockResolvedValue(token);
    expect((await middleware(request("/api/orders"))).status).toBe(401);
  });

  it("verifies the token with the NextAuth secret and the cookie name that matches the app URL", async () => {
    getToken.mockResolvedValue(null);
    await middleware(request("/api/orders"));
    expect(getToken).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "test-secret-test-secret", cookieName: "__Secure-next-auth.session-token" }),
    );
  });
});
