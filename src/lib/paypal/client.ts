/**
 * PayPal REST client: OAuth2 client-credentials token manager plus an authenticated request helper.
 *
 *  - The access token is cached and refreshed automatically 60 seconds before it expires.
 *  - Concurrent callers share one in-flight token request.
 *  - A 401 from the API invalidates the cached token and retries the call once with a fresh one.
 *  - Errors carry PayPal's `name`, a short `message` and `debug_id`; never credentials, tokens or
 *    request bodies.
 *
 * Everything is injected (credentials, fetch, clock), so the client is unit-testable offline.
 * Only the sandbox is in scope; the base URL is a parameter, not a feature.
 */
import type { z } from "zod";
import { PayPalError, describeIssues, type PayPalIssue } from "./errors";
import { PayPalErrorBodySchema, TokenResponseSchema } from "./types";

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
/** Refresh this long before the token's real expiry. */
export const TOKEN_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Clock in ms, injectable for tests. */
  now?: () => number;
  timeoutMs?: number;
}

export interface PayPalRequestInit {
  method: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Sent as the PayPal-Request-Id header, which makes the call idempotent on PayPal's side. */
  requestId?: string;
}

/** A zod schema whose OUTPUT is T; the input type is unconstrained so `.default(...)` fields work. */
export type ResponseSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

export interface PayPalClient {
  request<T>(path: string, init: PayPalRequestInit, schema: ResponseSchema<T>): Promise<T>;
}

export function createPayPalClient(options: PayPalClientOptions): PayPalClient {
  const baseUrl = (options.baseUrl ?? PAYPAL_SANDBOX_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cached: { value: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      throw new PayPalError(aborted ? "PayPal request timed out" : "PayPal could not be reached");
    } finally {
      clearTimeout(timer);
    }
  }

  async function failure(response: Response, what: string): Promise<PayPalError> {
    let detail = "";
    let debugId: string | undefined;
    let issues: PayPalIssue[] = [];
    try {
      const parsed = PayPalErrorBodySchema.safeParse(await response.json());
      if (parsed.success) {
        debugId = parsed.data.debug_id;
        detail = [parsed.data.name, parsed.data.message].filter(Boolean).join(": ").slice(0, 160);
        // Issue code, field NAME and description only: never the offending value, which could be personal data.
        issues = (parsed.data.details ?? []).slice(0, 5).map((d) => ({
          ...(d.issue ? { issue: d.issue.slice(0, 80) } : {}),
          ...(d.field ? { field: d.field.slice(0, 120) } : {}),
          ...(d.description ? { description: d.description.slice(0, 160) } : {}),
        }));
      }
    } catch {
      /* body was not JSON */
    }
    const suffix = [detail, issues.length ? `issues: ${describeIssues(issues)}` : "", debugId ? `debug_id ${debugId}` : ""].filter(Boolean).join(" | ");
    return new PayPalError(`${what} failed with HTTP ${response.status}${suffix ? ` (${suffix})` : ""}`, response.status, debugId, issues);
  }

  async function fetchToken(): Promise<string> {
    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
    const response = await send(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw await failure(response, "PayPal authentication");
    const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new PayPalError("PayPal returned an unusable token response");
    cached = { value: parsed.data.access_token, expiresAt: now() + parsed.data.expires_in * 1000 };
    return cached.value;
  }

  async function getAccessToken(): Promise<string> {
    if (cached && now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) return cached.value;
    inflight ??= fetchToken().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function request<T>(path: string, init: PayPalRequestInit, schema: ResponseSchema<T>): Promise<T> {
    const what = `PayPal ${init.method} ${path.split("?")[0]}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getAccessToken();
      const response = await send(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });

      if (response.status === 401 && attempt === 0) {
        cached = null; // the token was rejected (revoked or expired early): fetch a new one and retry once
        await response.text().catch(() => undefined);
        continue;
      }
      if (!response.ok) throw await failure(response, what);

      const parsed = schema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new PayPalError(`${what} returned a response in an unexpected shape`, response.status);
      return parsed.data;
    }
    throw new PayPalError(`${what} was not authorised`, 401);
  }

  return { request };
}
