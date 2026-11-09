import { describe, expect, it } from "vitest";
import { chatCompletionsUrl } from "../chat-completions";
import { getLlmEnv } from "../../env";
import { EXCERPT_MAX, excerpt, formatSmokeLine, runSmoke, smokeTargets, type SmokeTarget } from "../smoke";
import { FALLBACK_KEY, GEMINI_URL, GROQ_URL, PRIMARY_KEY, errorResponse, mockFetch, requestBody, requestUrl, textResponse, toolCallResponse } from "./fixtures";

const primary: SmokeTarget = {
  role: "primary",
  label: "gemini",
  model: "gemini-3.8-flash",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: PRIMARY_KEY,
  keyVar: "LLM_API_KEY",
};
const fallback: SmokeTarget = {
  role: "fallback",
  label: "groq",
  model: "openai/gpt-oss-120b",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: FALLBACK_KEY,
  keyVar: "LLM_FALLBACK_API_KEY",
};

const pingOk = () => toolCallResponse({ ok: true }, "ping");

describe("runSmoke", () => {
  it("skips a provider whose key is empty, with a clear message and no network call", async () => {
    const fetchMock = mockFetch();
    const result = await runSmoke({ ...fallback, apiKey: "" }, fetchMock);

    expect(result).toMatchObject({ status: "skipped", role: "fallback", label: "groq" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(formatSmokeLine(result)).toContain("SKIPPED (LLM_FALLBACK_API_KEY is empty)");
  });

  it("pinned tool_choice accepted: one request, HTTP 200, no JSON retry, PASS", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(pingOk());

    const result = await runSmoke(primary, fetchMock);

    expect(result).toMatchObject({ status: "pass", httpStatus: 200, pinned: "accepted", jsonRetryUsed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = requestBody(fetchMock, 0);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "ping" } }); // the real pinned path
    const line = formatSmokeLine(result);
    expect(line).toContain("gemini-3.8-flash");
    expect(line).toContain("HTTP 200");
    expect(line).toContain("pinned tool_choice: ACCEPTED");
    expect(line).toContain("JSON retry: not needed");
    expect(line).toMatch(/PASS$/);
  });

  it("pinned tool_choice rejected (HTTP 400): reports the rejection and that the JSON retry was needed", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(errorResponse(400)).mockResolvedValueOnce(textResponse('{"ok":true}'));

    const result = await runSmoke(primary, fetchMock);

    expect(result).toMatchObject({
      status: "pass",
      pinned: "rejected",
      rejectedStatus: 400,
      jsonRetryUsed: true,
      httpStatus: 200, // the retry's status
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const line = formatSmokeLine(result);
    expect(line).toContain("pinned tool_choice: REJECTED (HTTP 400)");
    expect(line).toContain("JSON retry: used");
    expect(line).toMatch(/PASS$/);
  });

  it("provider accepts the parameter but answers in text: reported as 'accepted but answered in text'", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(textResponse('{"ok":true}'));

    const result = await runSmoke(primary, fetchMock);

    expect(result).toMatchObject({ status: "pass", pinned: "ignored", jsonRetryUsed: false });
    expect(formatSmokeLine(result)).toContain("accepted but answered in text");
  });

  it("a failure (429) is FAIL with the status code, tests only this provider, and does not claim a pinned result", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(errorResponse(429));

    const result = await runSmoke(primary, fetchMock);

    expect(result).toMatchObject({ status: "fail", httpStatus: 429, pinned: "unknown", jsonRetryUsed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no fallback chain, no retry on a rate limit
    expect(requestUrl(fetchMock, 0)).toBe(GEMINI_URL);
    const line = formatSmokeLine(result);
    expect(line).toContain("HTTP 429");
    expect(line).toContain("pinned tool_choice: not determined");
    expect(line).toContain("FAIL");
  });

  it("each provider is checked on its own: the fallback is called at its own URL even when the primary fails", async () => {
    const fetchMock = mockFetch().mockResolvedValueOnce(errorResponse(500)).mockResolvedValueOnce(pingOk());

    const a = await runSmoke(primary, fetchMock);
    const b = await runSmoke(fallback, fetchMock);

    expect(a.status).toBe("fail");
    expect(b.status).toBe("pass");
    expect([requestUrl(fetchMock, 0), requestUrl(fetchMock, 1)]).toEqual([GEMINI_URL, GROQ_URL]);
  });
});

describe("output safety", () => {
  it("never prints keys, base URLs or query strings, and caps any detail at 80 characters", async () => {
    const withQuery: SmokeTarget = { ...primary, baseUrl: "https://llm.example.test/v1?api-version=QUERYSECRET" };
    const fetchMock = mockFetch().mockResolvedValueOnce(errorResponse(401));

    const result = await runSmoke(withQuery, fetchMock);
    const line = formatSmokeLine(result);

    expect(line).not.toContain(PRIMARY_KEY);
    expect(line).not.toContain("QUERYSECRET");
    expect(line).not.toContain("llm.example.test");
    expect(line).not.toContain("bad request for key"); // the provider's response body
    expect(result.detail!.length).toBeLessThanOrEqual(EXCERPT_MAX);
    // ...and the request still went to the right place, query string intact at the end of the URL
    expect(requestUrl(fetchMock, 0)).toBe("https://llm.example.test/v1/chat/completions?api-version=QUERYSECRET");
  });

  it("excerpt() collapses whitespace and truncates to 80 characters", () => {
    expect(excerpt("a   b\n c")).toBe("a b c");
    const long = excerpt("x".repeat(500));
    expect(long).toHaveLength(80);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("smokeTargets", () => {
  it("lists both providers independently, and a set fallback key is checked even when the primary key is empty", () => {
    const targets = smokeTargets(getLlmEnv({ LLM_FALLBACK_API_KEY: "fb-key" }));
    expect(targets.map((t) => [t.role, t.label, t.keyVar, Boolean(t.apiKey)])).toEqual([
      ["primary", "gemini", "LLM_API_KEY", false],
      ["fallback", "groq", "LLM_FALLBACK_API_KEY", true],
    ]);
  });
});

describe("chatCompletionsUrl", () => {
  it("appends to the path and keeps a query string at the end", () => {
    expect(chatCompletionsUrl("https://api.groq.com/openai/v1")).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(chatCompletionsUrl("https://x.test/v1beta/openai/")).toBe("https://x.test/v1beta/openai/chat/completions");
    expect(chatCompletionsUrl("https://x.test/v1?api-version=2024")).toBe("https://x.test/v1/chat/completions?api-version=2024");
  });
});
