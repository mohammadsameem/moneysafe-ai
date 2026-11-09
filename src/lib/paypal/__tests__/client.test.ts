import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TOKEN_REFRESH_BUFFER_MS, createPayPalClient } from "../client";
import { PayPalError } from "../errors";

const CLIENT_ID = "CLIENT-ID-ABC";
const CLIENT_SECRET = "CLIENT-SECRET-XYZ-123";
const BASE = "https://api-m.sandbox.paypal.com";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = (value: string, expiresIn = 32_400) => json({ access_token: value, expires_in: expiresIn, token_type: "Bearer" });
const Shape = z.object({ id: z.string() });

function setup() {
  let clock = 1_000_000;
  const fetchMock = vi.fn<typeof fetch>();
  const client = createPayPalClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl: fetchMock,
    now: () => clock,
  });
  return { fetchMock, client, advance: (ms: number) => (clock += ms) };
}

const urlOf = (m: ReturnType<typeof vi.fn<typeof fetch>>, n: number) => String(m.mock.calls[n]?.[0]);
const headersOf = (m: ReturnType<typeof vi.fn<typeof fetch>>, n: number) => (m.mock.calls[n]?.[1]?.headers ?? {}) as Record<string, string>;

describe("OAuth token management", () => {
  it("fetches a token with Basic auth, caches it, and reuses it for later calls", async () => {
    const { fetchMock, client } = setup();
    fetchMock
      .mockResolvedValueOnce(token("TOKEN-1"))
      .mockResolvedValueOnce(json({ id: "A" }))
      .mockResolvedValueOnce(json({ id: "B" }));

    await client.request("/v2/checkout/orders/A", { method: "GET" }, Shape);
    await client.request("/v2/checkout/orders/B", { method: "GET" }, Shape);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 token + 2 API calls, not 2 tokens
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/v1/oauth2/token`);
    expect(headersOf(fetchMock, 0).Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toBe("grant_type=client_credentials");
    expect(headersOf(fetchMock, 1).Authorization).toBe("Bearer TOKEN-1");
    expect(headersOf(fetchMock, 2).Authorization).toBe("Bearer TOKEN-1");
  });

  it("keeps using the cached token until it is within 60 seconds of expiring", async () => {
    const { fetchMock, client, advance } = setup();
    fetchMock
      .mockResolvedValueOnce(token("TOKEN-1", 3600))
      .mockResolvedValueOnce(json({ id: "A" }))
      .mockResolvedValueOnce(json({ id: "B" }));

    await client.request("/a", { method: "GET" }, Shape);
    advance(3600 * 1000 - TOKEN_REFRESH_BUFFER_MS - 1); // 61 s of validity left: still outside the buffer
    await client.request("/b", { method: "GET" }, Shape);

    expect(fetchMock).toHaveBeenCalledTimes(3); // one token request, two API calls
    expect(headersOf(fetchMock, 2).Authorization).toBe("Bearer TOKEN-1");
  });

  it("requests a new token when the cached one is inside the 60 second buffer", async () => {
    const { fetchMock, client, advance } = setup();
    fetchMock
      .mockResolvedValueOnce(token("TOKEN-1", 3600))
      .mockResolvedValueOnce(json({ id: "A" }))
      .mockResolvedValueOnce(token("TOKEN-2", 3600))
      .mockResolvedValueOnce(json({ id: "B" }));

    await client.request("/a", { method: "GET" }, Shape);
    advance(3600 * 1000 - TOKEN_REFRESH_BUFFER_MS + 1); // now inside the buffer
    await client.request("/b", { method: "GET" }, Shape);

    expect(urlOf(fetchMock, 2)).toBe(`${BASE}/v1/oauth2/token`);
    expect(headersOf(fetchMock, 3).Authorization).toBe("Bearer TOKEN-2");
  });

  it("concurrent callers share one token request", async () => {
    const { fetchMock, client } = setup();
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/v1/oauth2/token") ? token("TOKEN-1") : json({ id: "X" }),
    );

    await Promise.all([
      client.request("/a", { method: "GET" }, Shape),
      client.request("/b", { method: "GET" }, Shape),
      client.request("/c", { method: "GET" }, Shape),
    ]);

    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("a 401 from the API drops the cached token, fetches a fresh one and retries once", async () => {
    const { fetchMock, client } = setup();
    fetchMock
      .mockResolvedValueOnce(token("OLD"))
      .mockResolvedValueOnce(json({ name: "AUTHENTICATION_FAILURE" }, 401))
      .mockResolvedValueOnce(token("NEW"))
      .mockResolvedValueOnce(json({ id: "A" }));

    await expect(client.request("/a", { method: "GET" }, Shape)).resolves.toEqual({ id: "A" });
    expect(headersOf(fetchMock, 3).Authorization).toBe("Bearer NEW");
  });

  it("gives up after one retry if the 401 repeats", async () => {
    const { fetchMock, client } = setup();
    fetchMock
      .mockResolvedValueOnce(token("OLD"))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token("NEW"))
      .mockResolvedValueOnce(json({}, 401));

    await expect(client.request("/a", { method: "GET" }, Shape)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("requests", () => {
  it("sends PayPal-Request-Id when given, and a JSON body", async () => {
    const { fetchMock, client } = setup();
    fetchMock.mockResolvedValueOnce(token("T")).mockResolvedValueOnce(json({ id: "A" }));

    await client.request("/v2/x", { method: "POST", body: { a: 1 }, requestId: "req-123" }, Shape);

    expect(headersOf(fetchMock, 1)["PayPal-Request-Id"]).toBe("req-123");
    expect(headersOf(fetchMock, 1)["Content-Type"]).toBe("application/json");
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toBe('{"a":1}');
  });

  it("rejects a response that does not match the schema", async () => {
    const { fetchMock, client } = setup();
    fetchMock.mockResolvedValueOnce(token("T")).mockResolvedValueOnce(json({ unexpected: true }));
    await expect(client.request("/a", { method: "GET" }, Shape)).rejects.toThrow(/unexpected shape/);
  });
});

describe("errors never leak credentials", () => {
  it("an HTTP error carries PayPal's name, message and debug_id, but no secret, token or body dump", async () => {
    const { fetchMock, client } = setup();
    fetchMock.mockResolvedValueOnce(token("SECRET-TOKEN-VALUE")).mockResolvedValueOnce(
      json({ name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", debug_id: "dbg-42" }, 422),
    );

    const err = await client.request("/v2/checkout/orders", { method: "POST", body: { secret: "payload" } }, Shape).catch((e) => e);

    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, debugId: "dbg-42" });
    expect(err.message).toContain("HTTP 422");
    expect(err.message).toContain("dbg-42");
    const everything = `${err.message} ${JSON.stringify(err)}`;
    for (const secret of [CLIENT_ID, CLIENT_SECRET, "SECRET-TOKEN-VALUE", "payload"]) expect(everything).not.toContain(secret);
  });

  it("a failed authentication is reported without the client secret", async () => {
    const { fetchMock, client } = setup();
    fetchMock.mockResolvedValueOnce(json({ name: "invalid_client", message: "Client Authentication failed" }, 401));
    const err = await client.request("/a", { method: "GET" }, Shape).catch((e) => e);
    expect(err.message).toContain("authentication failed with HTTP 401");
    expect(err.message).not.toContain(CLIENT_SECRET);
    expect(err.message).not.toContain(Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"));
  });

  it("a network failure becomes a PayPalError with no detail", async () => {
    const { fetchMock, client } = setup();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(client.request("/a", { method: "GET" }, Shape)).rejects.toThrow("PayPal could not be reached");
  });
});
