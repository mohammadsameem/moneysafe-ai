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

  it.each(["/api/orders", "/api/orders/paypal-return?token=ABC", "/api/orders/paypal-cancel", "/api/anything-else"])(
    "returns 401 JSON for %s without a session",
    async (path) => {
      getToken.mockResolvedValue(null);
      const res = await middleware(request(path));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    },
  );

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
