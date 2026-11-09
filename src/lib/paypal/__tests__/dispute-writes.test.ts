import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPayPalClient } from "../client";
import { performLiveDisputeWrite } from "../dispute-writes";
import type { PayPalDisputeWrite } from "../disputes";
import { PayPalError } from "../errors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup() {
  const api = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const fetchMock = vi.fn<typeof fetch>(async (url, init) =>
    String(url).endsWith("/v1/oauth2/token") ? json({ access_token: "T", expires_in: 3600 }) : api(String(url), init ?? {}),
  );
  const client = createPayPalClient({ clientId: "id", clientSecret: "secret", fetchImpl: fetchMock });
  const sent = (n = 0) => ({
    url: new URL(String(api.mock.calls[n]?.[0])),
    init: api.mock.calls[n]?.[1] ?? {},
    headers: (api.mock.calls[n]?.[1]?.headers ?? {}) as Record<string, string>,
    body: JSON.parse(String(api.mock.calls[n]?.[1]?.body ?? "null")) as unknown,
  });
  return { api, client, sent };
}

const EVIDENCE: PayPalDisputeWrite = { kind: "submit_evidence", disputeId: "local-id", body: { evidences: [{ evidence_type: "DECLARATION", notes: "Hello" }] } };
const ACCEPT: PayPalDisputeWrite = { kind: "accept_claim", disputeId: "local-id", body: { note: "Accepted", accept_claim_type: "REFUND" } };

describe("performLiveDisputeWrite", () => {
  it("submit_evidence: POSTs the body to provide-evidence with the stored PayPal-Request-Id", async () => {
    const { api, client, sent } = setup();
    api.mockResolvedValueOnce(json({ links: [{ rel: "self", href: "https://api.sandbox.paypal.com/x" }] }));

    const response = await performLiveDisputeWrite(client, "PP-D-1", EVIDENCE, "req-123");

    expect(response).toEqual({ links: [{ rel: "self", href: "https://api.sandbox.paypal.com/x" }] });
    expect(sent().url.pathname).toBe("/v1/customer/disputes/PP-D-1/provide-evidence");
    expect(sent().init.method).toBe("POST");
    expect(sent().headers["PayPal-Request-Id"]).toBe("req-123");
    expect(sent().body).toEqual(EVIDENCE.body);
  });

  it("accept_claim: POSTs { note, accept_claim_type: 'REFUND' } to accept-claim", async () => {
    const { api, client, sent } = setup();
    api.mockResolvedValueOnce(json({}));
    await performLiveDisputeWrite(client, "PP-D-1", ACCEPT, "req-456");
    expect(sent().url.pathname).toBe("/v1/customer/disputes/PP-D-1/accept-claim");
    expect(sent().headers["PayPal-Request-Id"]).toBe("req-456");
    expect(sent().body).toEqual({ note: "Accepted", accept_claim_type: "REFUND" });
  });

  it("URL-encodes the PayPal dispute id", async () => {
    const { api, client, sent } = setup();
    api.mockResolvedValueOnce(json({}));
    await performLiveDisputeWrite(client, "PP/../D 1", ACCEPT, "r");
    expect(sent().url.pathname).toBe("/v1/customer/disputes/PP%2F..%2FD%201/accept-claim");
  });

  it("repeats the SAME request id on a retry", async () => {
    const { api, client, sent } = setup();
    api.mockResolvedValueOnce(json({ name: "INTERNAL_SERVER_ERROR" }, 500)).mockResolvedValueOnce(json({}));
    await expect(performLiveDisputeWrite(client, "PP-D-1", EVIDENCE, "same-id")).rejects.toBeInstanceOf(PayPalError);
    await performLiveDisputeWrite(client, "PP-D-1", EVIDENCE, "same-id");
    expect(sent(0).headers["PayPal-Request-Id"]).toBe("same-id");
    expect(sent(1).headers["PayPal-Request-Id"]).toBe("same-id");
  });

  it("surfaces a PayPal error with its status and debug id, never the request body", async () => {
    const { api, client } = setup();
    api.mockResolvedValueOnce(json({ name: "UNPROCESSABLE_ENTITY", message: "Invalid evidence type", debug_id: "dbg-1" }, 422));
    const err = (await performLiveDisputeWrite(client, "PP-D-1", EVIDENCE, "r").catch((e: unknown) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("dbg-1");
    expect(err.message).not.toContain("Hello");
  });
});

describe("structural: live dispute writes are reachable only through the executor (REQ-NFR-03)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? (name === "__tests__" || name === "node_modules" ? [] : walk(full)) : full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
    });
  const src = join(__dirname, "..", "..", "..");
  const files = walk(src).map((f) => ({ f: f.slice(src.length + 1).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));

  it("only the dispute executor imports dispute-writes, and the PayPal index does not export it", () => {
    const importers = files.filter((x) => /["'][^"']*dispute-writes["']/.test(x.text)).map((x) => x.f);
    expect(importers).toEqual(["lib/disputes/executor.ts"]);
    expect(readFileSync(join(src, "lib", "paypal", "index.ts"), "utf8")).not.toContain("dispute-writes");
  });

  it("the executor reaches it only inside the function it hands to submitEvidence / acceptClaim", () => {
    const text = files.find((x) => x.f === "lib/disputes/executor.ts")!.text;
    expect(text.match(/performLiveDisputeWrite\(/g)).toHaveLength(1);
    expect(text).toContain("submitEvidence(");
    expect(text).toContain("acceptClaim(");
  });
});
