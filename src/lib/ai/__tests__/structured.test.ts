import { describe, expect, it } from "vitest";
import {
  LlmNotConfiguredError,
  LlmUnavailableError,
  LlmValidationError,
} from "../errors";
import { callStructured, type LlmAttempt } from "../structured";
import {
  FALLBACK_KEY,
  GEMINI,
  GEMINI_URL,
  GROQ,
  GROQ_URL,
  PRIMARY_KEY,
  PROMPT,
  SCHEMA,
  TOOL,
  errorResponse,
  mockFetch,
  requestBody,
  requestHeaders,
  type RequestBody,
  requestUrl,
  textResponse,
  toolCallResponse,
} from "./fixtures";

function run(fetchMock: ReturnType<typeof mockFetch>, providers = [GEMINI, GROQ], attempts: LlmAttempt[] = []) {
  return callStructured({
    providers,
    tool: TOOL,
    schema: SCHEMA,
    prompt: PROMPT,
    fetchImpl: fetchMock,
    onAttempt: (a) => void attempts.push(a),
  });
}

describe("success", () => {
  it("calls {base}/chat/completions with the tool pinned by name and returns validated data", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(toolCallResponse({ explanation: "Three signals fired." }));
    const attempts: LlmAttempt[] = [];

    const out = await run(fetchMock, [GEMINI, GROQ], attempts);

    expect(out).toEqual({ data: { explanation: "Three signals fired." }, provider: "gemini", mode: "tool" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the fallback provider is not touched

    expect(requestUrl(fetchMock, 0)).toBe(GEMINI_URL); // trailing slash in the base URL is handled
    expect(requestHeaders(fetchMock, 0).Authorization).toBe(`Bearer ${PRIMARY_KEY}`);

    const body = requestBody(fetchMock, 0);
    expect(body.model).toBe("gemini-3.8-flash");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "risk_explanation" } });
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]).toMatchObject({ type: "function", function: { name: "risk_explanation" } });

    expect(attempts).toEqual([
      expect.objectContaining({ provider: "gemini", role: "primary", mode: "tool", outcome: "success", detail: "ok" }),
    ]);
  });

  it("accepts a provider that ignores tool_choice and answers in plain JSON text (no extra call)", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(textResponse('{"explanation":"From text."}'));
    const out = await run(fetchMock);
    expect(out.data).toEqual({ explanation: "From text." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pinned tool_choice rejected -> one JSON-only retry on the same provider", () => {
  it("retries once without tools, parses JSON from the message, and keeps the <data> section untouched", async () => {
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(errorResponse(400)) // provider rejects the pinned tool_choice
      .mockResolvedValueOnce(textResponse('Sure!\n```json\n{"explanation":"Parsed from a fenced block."}\n```'));
    const attempts: LlmAttempt[] = [];

    const out = await run(fetchMock, [GEMINI, GROQ], attempts);

    expect(out).toEqual({ data: { explanation: "Parsed from a fenced block." }, provider: "gemini", mode: "json" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock, 0)).toBe(GEMINI_URL);
    expect(requestUrl(fetchMock, 1)).toBe(GEMINI_URL); // same provider, not the fallback

    const first = requestBody(fetchMock, 0);
    const retry = requestBody(fetchMock, 1);
    expect(first.tool_choice).toBeDefined();
    expect(retry.tools).toBeUndefined();
    expect(retry.tool_choice).toBeUndefined();

    // JSON-only instruction is a separate static system message that carries the schema...
    const instruction = retry.messages.find((m) => m.role === "system");
    expect(instruction?.content).toContain("ONLY a single JSON object");
    expect(instruction?.content).toContain('"explanation"');
    // ...and the user message (with the untrusted <data> section) is byte-identical in both requests.
    const userOf = (b: RequestBody) => b.messages.filter((m) => m.role === "user");
    expect(userOf(first)).toEqual([{ role: "user", content: PROMPT }]);
    expect(userOf(retry)).toEqual([{ role: "user", content: PROMPT }]);

    expect(attempts.map((a) => [a.mode, a.outcome, a.detail])).toEqual([
      ["tool", "error", "HTTP 400"],
      ["json", "success", "ok"],
    ]);
  });

  it("does not use the JSON retry for rate limits: 429 goes straight to the next provider", async () => {
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(toolCallResponse({ explanation: "From the fallback provider." }));
    const out = await run(fetchMock);
    expect(out.provider).toBe("groq");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock, 1)).toBe(GROQ_URL);
    expect(requestBody(fetchMock, 1).tool_choice).toBeDefined(); // fallback starts with the pinned tool
  });
});

describe("validation", () => {
  it("a response that fails the zod schema throws LlmValidationError and does not try the other provider", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(toolCallResponse({ explanation: 123 }));
    const attempts: LlmAttempt[] = [];

    await expect(run(fetchMock, [GEMINI, GROQ], attempts)).rejects.toBeInstanceOf(LlmValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([
      expect.objectContaining({ provider: "gemini", outcome: "error", detail: "validation failed" }),
    ]);
  });

  it("non-JSON text throws LlmValidationError", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(textResponse("I cannot help with that."));
    await expect(run(fetchMock)).rejects.toBeInstanceOf(LlmValidationError);
  });
});

describe("provider failures", () => {
  it("429 on the primary, then a failing fallback: every provider is tried exactly once, then LlmUnavailableError", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(errorResponse(429)).mockResolvedValueOnce(errorResponse(500));
    const attempts: LlmAttempt[] = [];

    const err = await run(fetchMock, [GEMINI, GROQ], attempts).catch((e) => e);

    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([requestUrl(fetchMock, 0), requestUrl(fetchMock, 1)]).toEqual([GEMINI_URL, GROQ_URL]);
    expect(attempts.map((a) => [a.provider, a.role, a.outcome, a.detail])).toEqual([
      ["gemini", "primary", "error", "HTTP 429"],
      ["groq", "fallback", "error", "HTTP 500"],
    ]);
  });

  it("a network error moves on to the fallback provider", async () => {
    const fetchMock = mockFetch()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(toolCallResponse({ explanation: "Recovered." }));
    const out = await run(fetchMock);
    expect(out.provider).toBe("groq");
  });

  it("errors and attempt logs never contain API keys or provider response bodies", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(errorResponse(401)).mockResolvedValueOnce(errorResponse(401));
    const attempts: LlmAttempt[] = [];
    const err = await run(fetchMock, [GEMINI, GROQ], attempts).catch((e) => e);

    const everything = JSON.stringify({ attempts, message: err.message, failures: err.failures });
    expect(everything).not.toContain(PRIMARY_KEY);
    expect(everything).not.toContain(FALLBACK_KEY);
    expect(everything).not.toContain("bad request for key"); // the provider's body was not echoed
  });
});

describe("not configured", () => {
  it("with no providers it throws LlmNotConfiguredError and makes no network call", async () => {
    const fetchMock = mockFetch();
    await expect(run(fetchMock, [])).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("per-provider time allowance (shared by the pinned attempt and the JSON retry)", () => {
  /** A fetch that never answers; it fails only when the caller aborts it, like a real hung connection. */
  const hanging = (): typeof fetch =>
    ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as typeof fetch;

  it("the default allowance is 8 seconds", async () => {
    const { LLM_PROVIDER_TIMEOUT_MS } = await import("../providers");
    const { DEFAULT_TIMEOUT_MS } = await import("../chat-completions");
    expect(LLM_PROVIDER_TIMEOUT_MS).toBe(8_000);
    expect(DEFAULT_TIMEOUT_MS).toBe(8_000);
  });

  it("a hung provider is abandoned after its allowance and the next provider is tried", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).startsWith(GROQ_URL.slice(0, 20))) return toolCallResponse({ explanation: "From the fallback." });
      return hanging()(url as string, init);
    }) as typeof fetch;

    const started = Date.now();
    const out = await callStructured({ providers: [GEMINI, GROQ], tool: TOOL, schema: SCHEMA, prompt: PROMPT, fetchImpl, timeoutMs: 60 });

    expect(out.data).toEqual({ explanation: "From the fallback." });
    expect(out.provider).toBe("groq");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(2);
  });

  it("the JSON-only retry uses only what is LEFT of the allowance, so a provider never exceeds it", async () => {
    let call = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        await new Promise((r) => setTimeout(r, 120)); // the pinned attempt is rejected, but only after 120 ms
        return errorResponse(400);
      }
      return hanging()(url as string, init); // the retry hangs
    }) as typeof fetch;

    const started = Date.now();
    await expect(callStructured({ providers: [GEMINI], tool: TOOL, schema: SCHEMA, prompt: PROMPT, fetchImpl, timeoutMs: 200 })).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(call).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(190); // it did wait for the allowance...
    expect(elapsed).toBeLessThan(400); // ...but not a second full allowance (which would be ~320 ms)
  });

  it("an exhausted allowance makes the retry fail fast as a timeout instead of waiting again", async () => {
    let call = 0;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        await new Promise((r) => setTimeout(r, 80));
        return errorResponse(422);
      }
      return hanging()(url as string, init);
    }) as typeof fetch;

    const started = Date.now();
    await expect(callStructured({ providers: [GEMINI], tool: TOOL, schema: SCHEMA, prompt: PROMPT, fetchImpl, timeoutMs: 50 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(300);
  });
});
