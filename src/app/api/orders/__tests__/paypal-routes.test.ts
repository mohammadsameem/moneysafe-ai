import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionId = vi.fn();
const handlePayPalReturn = vi.fn();
const handlePayPalCancel = vi.fn();
const onWarning = vi.fn();

vi.mock("@/lib/session", () => ({ getSessionId: () => getSessionId() }));
vi.mock("@/lib/orders/runtime", () => ({ buildOrderDeps: () => ({ onWarning }) }));
vi.mock("@/lib/orders/service", () => ({
  handlePayPalReturn: (...args: unknown[]) => handlePayPalReturn(...args),
  handlePayPalCancel: (...args: unknown[]) => handlePayPalCancel(...args),
}));

import { GET as cancelGet } from "../paypal-cancel/route";
import { GET as returnGet } from "../paypal-return/route";

const BASE = "https://moneysafe.test";
const call = (handler: typeof returnGet, query: string) =>
  handler(new Request(`${BASE}/api/orders/paypal-x${query}`));
const location = (res: Response) => res.headers.get("location");

beforeEach(() => {
  process.env.NEXTAUTH_URL = `${BASE}/`;
  getSessionId.mockReset().mockResolvedValue("sid-1");
  handlePayPalReturn.mockReset();
  handlePayPalCancel.mockReset();
  onWarning.mockReset();
});

describe("GET /api/orders/paypal-return", () => {
  it("sends a caller without a session to /login and captures nothing", async () => {
    getSessionId.mockResolvedValue(null);
    const res = await call(returnGet, "?token=ABC123");
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${BASE}/login`);
    expect(handlePayPalReturn).not.toHaveBeenCalled();
  });

  it.each(["", "?token=", "?token=a%20b", "?token=x/../y"])("treats %j as an unknown order without calling the service", async (query) => {
    const res = await call(returnGet, query);
    expect(location(res)).toBe(`${BASE}/orders?notice=order_not_found`);
    expect(handlePayPalReturn).not.toHaveBeenCalled();
  });

  it("redirects to the order after a successful capture", async () => {
    handlePayPalReturn.mockResolvedValue({ kind: "ok", orderId: "o-1", scored: true });
    const res = await call(returnGet, "?token=ABC123&PayerID=XYZ");
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${BASE}/orders/o-1`);
    expect(handlePayPalReturn).toHaveBeenCalledWith("ABC123", "sid-1", expect.anything());
  });

  it("flags a captured order whose scoring failed", async () => {
    handlePayPalReturn.mockResolvedValue({ kind: "ok", orderId: "o-1", scored: false });
    expect(location(await call(returnGet, "?token=ABC123"))).toBe(`${BASE}/orders/o-1?notice=scoring_failed`);
  });

  it("redirects to the list with a notice, and logs only the safe message, when PayPal refuses the capture", async () => {
    handlePayPalReturn.mockResolvedValue({ kind: "capture_failed", orderId: "o-1", message: "PayPal POST failed with HTTP 422" });
    const res = await call(returnGet, "?token=ABC123");
    expect(location(res)).toBe(`${BASE}/orders?notice=capture_failed`);
    expect(onWarning).toHaveBeenCalledWith("capture failed: PayPal POST failed with HTTP 422");
  });

  it("reports a cancelled order and an unknown order", async () => {
    handlePayPalReturn.mockResolvedValueOnce({ kind: "cancelled", orderId: "o-1" });
    expect(location(await call(returnGet, "?token=ABC123"))).toBe(`${BASE}/orders?notice=order_cancelled`);
    handlePayPalReturn.mockResolvedValueOnce({ kind: "not_found" });
    expect(location(await call(returnGet, "?token=ABC123"))).toBe(`${BASE}/orders?notice=order_not_found`);
  });
});

describe("GET /api/orders/paypal-cancel", () => {
  it("sends a caller without a session to /login", async () => {
    getSessionId.mockResolvedValue(null);
    expect(location(await call(cancelGet, "?token=ABC123"))).toBe(`${BASE}/login`);
    expect(handlePayPalCancel).not.toHaveBeenCalled();
  });

  it("redirects to the list with a cancelled notice", async () => {
    handlePayPalCancel.mockResolvedValue({ kind: "cancelled", orderId: "o-1" });
    const res = await call(cancelGet, "?token=ABC123");
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${BASE}/orders?notice=order_cancelled`);
    expect(handlePayPalCancel).toHaveBeenCalledWith("ABC123", "sid-1", expect.anything());
  });

  it("treats a malformed token and an unknown order as not found", async () => {
    expect(location(await call(cancelGet, "?token=a%20b"))).toBe(`${BASE}/orders?notice=order_not_found`);
    handlePayPalCancel.mockResolvedValue({ kind: "not_found" });
    expect(location(await call(cancelGet, "?token=ABC123"))).toBe(`${BASE}/orders?notice=order_not_found`);
  });

  it("leaves an already paid order alone and shows no cancellation notice", async () => {
    handlePayPalCancel.mockResolvedValue({ kind: "not_cancellable", orderId: "o-1" });
    expect(location(await call(cancelGet, "?token=ABC123"))).toBe(`${BASE}/orders`);
  });
});
