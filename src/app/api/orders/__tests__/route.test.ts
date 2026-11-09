import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionId = vi.fn();
const createSandboxOrder = vi.fn();
const deps = { marker: "deps" };

vi.mock("@/lib/session", () => ({ getSessionId: () => getSessionId() }));
vi.mock("@/lib/orders/runtime", () => ({ buildOrderDeps: () => deps }));
vi.mock("@/lib/orders/service", () => ({
  createSandboxOrder: (...args: unknown[]) => createSandboxOrder(...args),
}));

import { POST } from "../route";

const body = {
  itemName: "Handmade mug",
  amountUsd: 40,
  shippingMethod: "standard",
  billingCountry: "us",
  shippingCountry: "us",
};

const post = (payload: unknown, raw = false) =>
  POST(
    new Request("http://localhost/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (payload as string) : JSON.stringify(payload),
    }),
  );

describe("POST /api/orders", () => {
  beforeEach(() => {
    getSessionId.mockReset().mockResolvedValue("sid-1");
    createSandboxOrder.mockReset();
  });

  it("returns 401 without a session and does nothing", async () => {
    getSessionId.mockResolvedValue(null);
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(createSandboxOrder).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is not JSON", async () => {
    const res = await post("{not json", true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(createSandboxOrder).not.toHaveBeenCalled();
  });

  it("returns 400 with the failing fields, not the submitted values", async () => {
    const res = await post({ ...body, amountUsd: -5, itemName: "SECRET-LOOKING-VALUE", shippingMethod: "drone" });
    const text = JSON.stringify(await res.clone().json());
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues: { field: string }[] };
    expect(json.error).toBe("invalid_request");
    expect(json.issues.map((i) => i.field).sort()).toEqual(["amountUsd", "shippingMethod"]);
    expect(text).not.toContain("SECRET-LOOKING-VALUE");
    expect(createSandboxOrder).not.toHaveBeenCalled();
  });

  it("returns 201 with the approval URL for a live PayPal order, passing the parsed input and session", async () => {
    createSandboxOrder.mockResolvedValue({ kind: "paypal", orderId: "o-1", approvalUrl: "https://www.sandbox.paypal.com/x" });

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orderId: "o-1", approvalUrl: "https://www.sandbox.paypal.com/x", isDemo: false });
    expect(createSandboxOrder).toHaveBeenCalledWith(
      expect.objectContaining({ billingCountry: "US", shippingCountry: "US", paymentAttemptCount: 1 }),
      "sid-1",
      deps,
    );
  });

  it("returns 201 with approvalUrl null and isDemo true for a demo order", async () => {
    createSandboxOrder.mockResolvedValue({ kind: "demo", orderId: "o-2", reason: "paypal_error" });

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orderId: "o-2", approvalUrl: null, isDemo: true, reason: "paypal_error" });
  });
});
