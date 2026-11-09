import { describe, expect, it, vi } from "vitest";
import { createPayPalClient } from "../client";
import { PayPalError } from "../errors";
import { addTracking, captureOrder, createOrder, getOrder, toMoney } from "../orders";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A client whose token request is answered automatically and whose API calls are scripted. */
function setup() {
  const api = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/v1/oauth2/token")) {
      return json({ access_token: "T", expires_in: 3600, token_type: "Bearer" });
    }
    return api(String(url), init ?? {});
  });
  const client = createPayPalClient({ clientId: "id", clientSecret: "secret", fetchImpl: fetchMock });
  const call = (n: number) => ({
    url: String(api.mock.calls[n]?.[0]),
    init: api.mock.calls[n]?.[1] ?? {},
    body: JSON.parse(String(api.mock.calls[n]?.[1]?.body ?? "{}")) as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  return { api, client, call };
}

describe("toMoney", () => {
  it("formats as a two-place decimal string, as PayPal requires", () => {
    expect(toMoney(210)).toBe("210.00");
    expect(toMoney(38.5)).toBe("38.50");
    expect(toMoney(0.1 + 0.2)).toBe("0.30");
  });
});

describe("createOrder", () => {
  it("creates an intent=CAPTURE order with the return and cancel URLs and returns the approval link", async () => {
    const { api, client, call } = setup();
    api.mockResolvedValueOnce(
      json({
        id: "5O190127TN364715T",
        status: "PAYER_ACTION_REQUIRED",
        links: [
          { href: "https://api.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self", method: "GET" },
          { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "payer-action", method: "GET" },
        ],
      }),
    );

    const out = await createOrder(client, {
      amountUsd: 210,
      itemName: "Hand-knitted merino throw",
      returnUrl: "https://app.test/api/orders/paypal-return",
      cancelUrl: "https://app.test/api/orders/paypal-cancel",
      requestId: "create-1",
    });

    expect(out).toEqual({
      paypalOrderId: "5O190127TN364715T",
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    });
    const sent = call(0);
    expect(sent.url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(sent.init.method).toBe("POST");
    expect((sent.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("create-1");
    expect(sent.body.intent).toBe("CAPTURE");
    expect(sent.body.purchase_units[0].amount).toEqual({
      currency_code: "USD",
      value: "210.00",
      breakdown: { item_total: { currency_code: "USD", value: "210.00" } },
    });
    expect(sent.body.purchase_units[0].items[0]).toMatchObject({ name: "Hand-knitted merino throw", quantity: "1" });
    expect(sent.body.payment_source.paypal.experience_context).toMatchObject({
      return_url: "https://app.test/api/orders/paypal-return",
      cancel_url: "https://app.test/api/orders/paypal-cancel",
    });
  });

  it("accepts the older 'approve' link relation", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(
      json({ id: "X1", status: "CREATED", links: [{ href: "https://www.sandbox.paypal.com/approve?token=X1", rel: "approve" }] }),
    );
    const out = await createOrder(client, { amountUsd: 5, itemName: "x", returnUrl: "https://a.test/r", cancelUrl: "https://a.test/c" });
    expect(out.approvalUrl).toBe("https://www.sandbox.paypal.com/approve?token=X1");
  });

  it("fails clearly if PayPal returns no approval link", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ id: "X1", status: "CREATED", links: [] }));
    await expect(
      createOrder(client, { amountUsd: 5, itemName: "x", returnUrl: "https://a.test/r", cancelUrl: "https://a.test/c" }),
    ).rejects.toThrow("no approval link");
  });
});

describe("captureOrder", () => {
  it("captures the order and returns the capture id and payer details", async () => {
    const { api, client, call } = setup();
    api.mockResolvedValueOnce(
      json({
        id: "5O190127TN364715T",
        status: "COMPLETED",
        payer: { email_address: "buyer@example.com", name: { given_name: "Daniel", surname: "Okafor" } },
        purchase_units: [{ payments: { captures: [{ id: "3C679366HH908993F", status: "COMPLETED" }] } }],
      }),
    );

    const out = await captureOrder(client, "5O190127TN364715T", "capture-1");

    expect(out).toEqual({
      paypalOrderId: "5O190127TN364715T",
      status: "COMPLETED",
      captureId: "3C679366HH908993F",
      payerEmail: "buyer@example.com",
      payerName: "Daniel Okafor",
    });
    expect(call(0).url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T/capture");
    expect((call(0).init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("capture-1");
  });

  it("fails if the capture response has no capture id (we could not add tracking later)", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ id: "O1", status: "COMPLETED", purchase_units: [{ payments: { captures: [] } }] }));
    await expect(captureOrder(client, "O1")).rejects.toThrow("no capture id");
  });

  it("url-encodes the order id", async () => {
    const { api, client, call } = setup();
    api.mockResolvedValueOnce(json({ id: "O1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C1" }] } }] }));
    await captureOrder(client, "a/b c");
    expect(call(0).url).toContain("/orders/a%2Fb%20c/capture");
  });
});

describe("getOrder", () => {
  it("returns the order with its line items for the Evidence Vault", async () => {
    const { api, client, call } = setup();
    api.mockResolvedValueOnce(
      json({
        id: "O1",
        status: "COMPLETED",
        create_time: "2026-11-01T10:00:00Z",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: "210.00" },
            items: [{ name: "Throw", quantity: "1", unit_amount: { currency_code: "USD", value: "210.00" }, category: "PHYSICAL_GOODS" }],
            payments: { captures: [{ id: "C1" }] },
          },
        ],
      }),
    );
    const order = await getOrder(client, "O1");
    expect(order.purchase_units[0]?.items?.[0]?.name).toBe("Throw");
    expect(call(0).init.method).toBe("GET");
  });
});

describe("addTracking", () => {
  it("posts capture id, tracking number and a PayPal carrier code to /track", async () => {
    const { api, client, call } = setup();
    api.mockResolvedValueOnce(json({ id: "O1" }));

    await addTracking(client, "O1", { captureId: "C1", trackingNumber: "9400111899223197428490", carrier: "usps", requestId: "trk-1" });

    expect(call(0).url).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/O1/track");
    expect(call(0).body).toEqual({
      capture_id: "C1",
      tracking_number: "9400111899223197428490",
      carrier: "USPS",
      notify_payer: false,
    });
  });

  it("sends an unlisted carrier as OTHER with its name", async () => {
    const { api, client, call } = setup();
    api.mockResolvedValueOnce(json({ id: "O1" }));
    await addTracking(client, "O1", { captureId: "C1", trackingNumber: "T1", carrier: "Canada Post", notifyPayer: true });
    expect(call(0).body).toMatchObject({ carrier: "OTHER", carrier_name_other: "Canada Post", notify_payer: true });
  });

  it("surfaces a PayPal error (so the caller can warn without blocking evidence assembly)", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ name: "INVALID_REQUEST", debug_id: "d1" }, 400));
    await expect(addTracking(client, "O1", { captureId: "C1", trackingNumber: "T1", carrier: "UPS" })).rejects.toBeInstanceOf(PayPalError);
  });
});
