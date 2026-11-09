import { describe, expect, it, vi } from "vitest";
import { callWithFallback, type LlmActivityEntry, type LlmDeps } from "../call-with-fallback";
import { callStructured } from "../structured";
import {
  FALLBACK_KEY,
  GEMINI,
  GROQ,
  PRIMARY_KEY,
  PROMPT,
  RULE_BASED,
  SCHEMA,
  TOOL,
  errorResponse,
  mockFetch,
  textResponse,
  toolCallResponse,
} from "./fixtures";

const META = { sessionId: "sess-1", toolName: "risk_explanation", inputSummary: "order score=55" };

function setup(opts: { providers?: typeof GEMINI[]; configured?: boolean; budget?: { allowed: boolean; reason?: "session" | "daily" } } = {}) {
  const fetchMock = mockFetch();
  const providers = opts.providers ?? [GEMINI, GROQ];
  const logs: LlmActivityEntry[] = [];
  const deps: LlmDeps = {
    isConfigured: () => (opts.configured ?? providers.length > 0),
    checkBudget: vi.fn(async () => opts.budget ?? { allowed: true }),
    logActivity: vi.fn(async (entry) => void logs.push(entry)),
  };
  const call = () =>
    callWithFallback(
      (ctx) =>
        callStructured({
          providers,
          tool: TOOL,
          schema: SCHEMA,
          prompt: PROMPT,
          fetchImpl: fetchMock,
          onAttempt: ctx.onAttempt,
        }).then((r) => r.data),
      RULE_BASED,
      META,
      deps,
    );
  return { fetchMock, deps, logs, call };
}

describe("callWithFallback", () => {
  it("success: returns the model result, uses no fallback, logs one success row naming the provider", async () => {
    const { fetchMock, logs, call } = setup();
    fetchMock.mockResolvedValueOnce(toolCallResponse({ explanation: "Model-written." }));

    const out = await call();

    expect(out).toEqual({ result: { explanation: "Model-written." }, usedFallback: false });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ stepType: "llm_call", toolName: "risk_explanation", status: "success", sessionId: "sess-1" });
    expect(logs[0]!.inputSummary).toContain("provider=gemini (primary)");
  });

  it("zod failure -> rule-based fallback; the second provider is not called", async () => {
    const { fetchMock, logs, call } = setup();
    fetchMock.mockResolvedValueOnce(toolCallResponse({ explanation: 42 }));

    const out = await call();

    expect(out).toEqual({ result: RULE_BASED, usedFallback: true, reason: "validation_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs.map((l) => l.status)).toEqual(["error", "fallback"]);
  });

  it("429 -> fallback provider -> model result (not rule-based), with both attempts logged by provider name", async () => {
    const { fetchMock, logs, call } = setup();
    fetchMock.mockResolvedValueOnce(errorResponse(429)).mockResolvedValueOnce(toolCallResponse({ explanation: "From Groq." }));

    const out = await call();

    expect(out).toEqual({ result: { explanation: "From Groq." }, usedFallback: false });
    expect(logs.map((l) => [l.status, l.outputSummary])).toEqual([
      ["error", "HTTP 429"],
      ["success", "ok"],
    ]);
    expect(logs[0]!.inputSummary).toContain("provider=gemini (primary)");
    expect(logs[1]!.inputSummary).toContain("provider=groq (fallback)");
  });

  it("429 -> fallback provider also fails -> rule-based; each provider tried once", async () => {
    const { fetchMock, logs, call } = setup();
    fetchMock.mockResolvedValueOnce(errorResponse(429)).mockResolvedValueOnce(errorResponse(503));

    const out = await call();

    expect(out).toEqual({ result: RULE_BASED, usedFallback: true, reason: "providers_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs.map((l) => l.status)).toEqual(["error", "error", "fallback"]);
  });

  it("pinned-tool rejection then JSON retry succeeds without falling back", async () => {
    const { fetchMock, call } = setup();
    fetchMock.mockResolvedValueOnce(errorResponse(400)).mockResolvedValueOnce(textResponse('{"explanation":"Via JSON."}'));

    const out = await call();
    expect(out).toEqual({ result: { explanation: "Via JSON." }, usedFallback: false });
  });

  it("empty key -> rule-based, no network call, no budget used", async () => {
    // LLM_API_KEY empty means no providers, even if a fallback key were set (see providers.test.ts).
    const { fetchMock, deps, logs, call } = setup({ providers: [] });

    const out = await call();

    expect(out).toEqual({ result: RULE_BASED, usedFallback: true, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.checkBudget).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe("fallback");
  });

  it("budget exceeded (session or daily) -> rule-based, no network call, logged as llm_budget_exceeded", async () => {
    for (const reason of ["session", "daily"] as const) {
      const { fetchMock, logs, call } = setup({ budget: { allowed: false, reason } });

      const out = await call();

      expect(out).toEqual({ result: RULE_BASED, usedFallback: true, reason: reason === "session" ? "budget_session" : "budget_daily" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logs[0]).toMatchObject({ toolName: "llm_budget_exceeded", status: "fallback", inputSummary: `limit=${reason}` });
    }
  });

  it("a failing activity logger never changes the outcome", async () => {
    const { fetchMock, deps, call } = setup();
    (deps.logActivity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    fetchMock.mockResolvedValueOnce(toolCallResponse({ explanation: "Still works." }));

    await expect(call()).resolves.toEqual({ result: { explanation: "Still works." }, usedFallback: false });
  });

  it("nothing written to the activity log contains an API key or a provider error body", async () => {
    const { fetchMock, logs, call } = setup();
    fetchMock.mockResolvedValueOnce(errorResponse(401)).mockResolvedValueOnce(errorResponse(401));

    await call();

    const everything = JSON.stringify(logs);
    expect(everything).not.toContain(PRIMARY_KEY);
    expect(everything).not.toContain(FALLBACK_KEY);
    expect(everything).not.toContain("bad request for key");
  });
});
