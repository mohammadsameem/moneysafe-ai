import { describe, expect, it, vi } from "vitest";
import { createPayPalClient } from "../client";
import { PayPalError } from "../errors";
import { withDemoFallback } from "../demo";
import { getDispute, listDisputes } from "../disputes-read";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup() {
  const api = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const fetchMock = vi.fn<typeof fetch>(async (url, init) =>
    String(url).endsWith("/v1/oauth2/token") ? json({ access_token: "T", expires_in: 3600 }) : api(String(url), init ?? {}),
  );
  return { api, client: createPayPalClient({ clientId: "id", clientSecret: "secret", fetchImpl: fetchMock }) };
}

const DISPUTE = {
  dispute_id: "PP-D-27803",
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_amount: { currency_code: "USD", value: "145.00" },
  seller_response_due_date: "2026-11-11T12:00:00.000Z",
  some_new_field_paypal_added: { anything: true },
};

describe("listDisputes", () => {
  it("GETs the disputes list with a bounded page size and returns the items", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ items: [DISPUTE], links: [] }));

    const items = await listDisputes(client, { pageSize: 500, disputeState: "REQUIRED_ACTION" });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ dispute_id: "PP-D-27803", seller_response_due_date: "2026-11-11T12:00:00.000Z" });
    const url = new URL(String(api.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v1/customer/disputes");
    expect(url.searchParams.get("page_size")).toBe("50"); // clamped
    expect(url.searchParams.get("dispute_state")).toBe("REQUIRED_ACTION");
    expect(api.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("treats a response with no items as an empty list", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({}));
    expect(await listDisputes(client)).toEqual([]);
  });

  it("rejects an item that is not shaped like a dispute instead of trusting it", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ items: [{ status: "OPEN" }] })); // no dispute_id
    await expect(listDisputes(client)).rejects.toBeInstanceOf(PayPalError);
  });
});

describe("getDispute", () => {
  it("GETs one dispute by id, URL-encoding the id", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json(DISPUTE));

    const d = await getDispute(client, "PP-D/27803?x=1");

    expect(d.dispute_id).toBe("PP-D-27803");
    expect(new URL(String(api.mock.calls[0]?.[0])).pathname).toBe("/v1/customer/disputes/PP-D%2F27803%3Fx%3D1");
  });

  it("surfaces PayPal's error as a PayPalError without leaking the response body", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ name: "RESOURCE_NOT_FOUND", message: "Dispute not found", debug_id: "abc123" }, 404));
    const err = await getDispute(client, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(404);
    expect(String((err as Error).message)).toContain("abc123");
  });

  it("falls back to the stored record through withDemoFallback when PayPal fails, and rethrows a bug", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ name: "INTERNAL_SERVER_ERROR" }, 500));
    const onFallback = vi.fn();

    const result = await withDemoFallback<unknown>(() => getDispute(client, "x"), () => "stored", { demoMode: false, onFallback });
    expect(result).toMatchObject({ data: "stored", isDemo: true, reason: "paypal_error" });
    expect(onFallback).toHaveBeenCalledTimes(1);

    await expect(withDemoFallback(async () => { throw new TypeError("bug"); }, () => "stored", { demoMode: false })).rejects.toThrow("bug");
  });
});
