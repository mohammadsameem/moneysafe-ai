import { describe, expect, it, vi } from "vitest";
import type { ActivityMeta } from "@/lib/activity/logger";
import type { LlmDeps } from "@/lib/ai/call-with-fallback";
import { GEMINI, GROQ, PRIMARY_KEY, errorResponse, mockFetch, requestBody, toolCallResponse } from "@/lib/ai/__tests__/fixtures";
import { BUYER_EMAIL, SEED_C, SEED_D, SEED_E, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import type { ArtefactInput } from "@/lib/scoring";
import { analyzeDispute } from "../analyze";
import { DISPUTE_ID, NOW, ORDER_ID, OTHER_SESSION, SESSION, analysed, createFakeAnalysisRepo, makeDispute, makeRecord } from "./fakes";

const COSTS = { chargebackFeeUsd: 20, contestEffortUsd: 10 };
const GOOD = {
  llm_adjustment: 0.05,
  reasoning: "The carrier marked the parcel Delivered and the buyer replied to your message, so contesting is well supported.",
  evidence_used: ["Tracking number and carrier", "Delivered scan"],
  evidence_gaps: [],
};
const DRAFT = "Hello PayPal Dispute Team,\n\nThe parcel was delivered under tracking 9400111899223197428490.\n\nThank you,\n[Your name]";

function setup(opts: { evidence?: readonly ArtefactInput[]; dispute?: Partial<ReturnType<typeof makeDispute>>; llm?: Partial<LlmDeps> } = {}) {
  const dispute = makeDispute({ disputedAmountUsd: 145, ...opts.dispute });
  const record = makeRecord(dispute, { riskScore: 12 });
  const repo = createFakeAnalysisRepo([record], artefactRows(ORDER_ID, opts.evidence ?? SEED_C));
  const logs: ActivityMeta[] = [];
  const llmLogs: ActivityMeta[] = [];
  const llm = {
    isConfigured: vi.fn<LlmDeps["isConfigured"]>(opts.llm?.isConfigured ?? (() => true)),
    checkBudget: vi.fn<LlmDeps["checkBudget"]>(opts.llm?.checkBudget ?? (async () => ({ allowed: true }))),
    logActivity: vi.fn<LlmDeps["logActivity"]>(async (e) => void llmLogs.push(e as unknown as ActivityMeta)),
  };
  const fetchImpl = mockFetch();
  const deps = {
    repo,
    explainer: { llm, getProviders: () => [GEMINI, GROQ], fetchImpl },
    costs: COSTS,
    now: () => NOW,
    log: async (m: ActivityMeta) => void logs.push(m),
  };
  return { repo, llm, fetchImpl, deps, logs, llmLogs };
}

describe("analyzeDispute: cached (seeded disputes make zero model calls)", () => {
  it("returns the stored analysis, calls no model, spends no budget and writes nothing", async () => {
    const { repo, llm, fetchImpl, deps, logs } = setup({ dispute: analysed({ isSeed: true, isDemo: false, sessionId: null }) });

    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);

    expect(out.kind).toBe("cached");
    if (out.kind !== "cached") return;
    expect(out.view.analysis).toMatchObject({ winProbability: 0.95, finalRecommendation: "contest", aiUnavailable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.isConfigured).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
    expect(llm.logActivity).not.toHaveBeenCalled();
    expect(repo.saves).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("a second call after a fresh analysis is cached and makes no further model call", async () => {
    const { fetchImpl, deps } = setup();
    fetchImpl.mockResolvedValueOnce(toolCallResponse(GOOD, "dispute_analysis")).mockResolvedValueOnce(toolCallResponse({ response_text: DRAFT }, "dispute_draft_response"));

    expect((await analyzeDispute(DISPUTE_ID, SESSION, deps)).kind).toBe("analyzed");
    const calls = fetchImpl.mock.calls.length;
    expect((await analyzeDispute(DISPUTE_ID, SESSION, deps)).kind).toBe("cached");
    expect(fetchImpl.mock.calls.length).toBe(calls);
    expect(deps.repo.saves).toHaveLength(1);
  });

  it("an analysis stored without AI is also cached (no automatic retry of the model)", async () => {
    const { fetchImpl, deps } = setup({ dispute: analysed({ winProbability: null, winLikelihoodLabel: null, llmAdjustment: null }) });
    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);
    expect(out.kind).toBe("cached");
    expect(out.kind === "cached" && out.view.analysis?.aiUnavailable).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("analyzeDispute: visibility", () => {
  it("unknown ids, malformed ids and other sessions' disputes are all 'not found'", async () => {
    const { deps } = setup();
    expect((await analyzeDispute("nope", SESSION, deps)).kind).toBe("not_found");
    expect((await analyzeDispute(DISPUTE_ID, OTHER_SESSION, deps)).kind).toBe("not_found");
    expect(deps.repo.saves).toHaveLength(0);
  });
});

describe("analyzeDispute: a fresh analysis", () => {
  it("INR with strong evidence: model adjusts and explains, then drafts a response; both saved once", async () => {
    const { repo, llm, fetchImpl, deps } = setup();
    fetchImpl.mockResolvedValueOnce(toolCallResponse(GOOD, "dispute_analysis")).mockResolvedValueOnce(toolCallResponse({ response_text: DRAFT }, "dispute_draft_response"));

    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);

    expect(out.kind).toBe("analyzed");
    if (out.kind !== "analyzed") return;
    expect(out.usedFallback).toBe(false);
    expect(requestBody(fetchImpl, 0).tool_choice?.function.name).toBe("dispute_analysis");
    expect(requestBody(fetchImpl, 1).tool_choice?.function.name).toBe("dispute_draft_response");
    expect(llm.checkBudget).toHaveBeenCalledTimes(2); // one unit per model call

    expect(repo.saves).toHaveLength(1);
    expect(repo.saves[0]).toEqual({
      baseWinProbability: 1,
      llmAdjustment: 0.05,
      winProbability: 0.95, // 1.0 + 0.05 clamped
      winLikelihoodLabel: "Strong",
      systemRecommendation: "contest",
      overrideRecommendation: null,
      finalRecommendation: "contest",
      recommendationSource: "system",
      reasoning: GOOD.reasoning,
      evidenceUsed: GOOD.evidence_used,
      evidenceGaps: [],
      draftResponse: DRAFT,
      analysisComputedAt: NOW.toISOString(),
      riskScoreSnapshot: 12,
    });
    expect(out.view.analysis).toMatchObject({ finalRecommendation: "contest", draftResponse: DRAFT, aiUnavailable: false });
  });

  it("refund (NAD, thin evidence, $38): no draft call, no draft saved", async () => {
    const { repo, fetchImpl, deps } = setup({ evidence: SEED_D, dispute: { reason: "not_as_described", disputedAmountUsd: 38 } });
    fetchImpl.mockResolvedValueOnce(toolCallResponse({ ...GOOD, llm_adjustment: 0, reasoning: "Only the basics are on file and the claim is about how the item looks, so a refund costs less." }, "dispute_analysis"));

    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(repo.saves[0]).toMatchObject({ systemRecommendation: "refund", finalRecommendation: "refund", draftResponse: null });
    expect(repo.saves[0]?.baseWinProbability).toBeCloseTo(0.2667, 4);
    expect(out.kind === "analyzed" && out.view.analysis?.draftResponse).toBeNull();
  });

  it("a model override to 'refund' skips the draft; an override to 'contest' triggers one", async () => {
    const toRefund = setup();
    toRefund.fetchImpl.mockResolvedValueOnce(toolCallResponse({ ...GOOD, override_recommendation: "refund" }, "dispute_analysis"));
    await analyzeDispute(DISPUTE_ID, SESSION, toRefund.deps);
    expect(toRefund.fetchImpl).toHaveBeenCalledTimes(1);
    expect(toRefund.repo.saves[0]).toMatchObject({ overrideRecommendation: "refund", finalRecommendation: "refund", recommendationSource: "ai_adjusted", draftResponse: null });

    const toContest = setup({ evidence: SEED_D, dispute: { reason: "not_as_described", disputedAmountUsd: 38 } });
    toContest.fetchImpl
      .mockResolvedValueOnce(toolCallResponse({ ...GOOD, override_recommendation: "contest", reasoning: "The listing text matches the item exactly and the invoice proves it, so contesting is reasonable." }, "dispute_analysis"))
      .mockResolvedValueOnce(toolCallResponse({ response_text: DRAFT }, "dispute_draft_response"));
    await analyzeDispute(DISPUTE_ID, SESSION, toContest.deps);
    expect(toContest.fetchImpl).toHaveBeenCalledTimes(2);
    expect(toContest.repo.saves[0]).toMatchObject({ systemRecommendation: "refund", overrideRecommendation: "contest", finalRecommendation: "contest", recommendationSource: "ai_adjusted", draftResponse: DRAFT });
  });

  it("clamps a wild adjustment before saving it", async () => {
    const { repo, fetchImpl, deps } = setup({ evidence: SEED_E, dispute: { disputedAmountUsd: 210 } });
    fetchImpl.mockResolvedValueOnce(toolCallResponse({ ...GOOD, llm_adjustment: -0.5 }, "dispute_analysis")).mockResolvedValueOnce(toolCallResponse({ response_text: DRAFT }, "dispute_draft_response"));
    await analyzeDispute(DISPUTE_ID, SESSION, deps);
    expect(repo.saves[0]?.llmAdjustment).toBe(-0.1);
    expect(repo.saves[0]?.winProbability).toBeCloseTo(0.4444 - 0.1, 3);
    expect(repo.saves[0]?.winLikelihoodLabel).toBe("Weak"); // 0.344
  });

  it("no model configured: stores the system recommendation, no win likelihood, and a template draft; no network call", async () => {
    const { repo, fetchImpl, deps, llm } = setup({ llm: { isConfigured: () => false } });

    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
    expect(out.kind === "analyzed" && out.usedFallback).toBe(true);
    const saved = repo.saves[0]!;
    expect(saved).toMatchObject({ llmAdjustment: null, winProbability: null, winLikelihoodLabel: null, overrideRecommendation: null, systemRecommendation: "contest", finalRecommendation: "contest", recommendationSource: "system" });
    expect(saved.reasoning).toContain("The AI step was unavailable");
    expect(saved.draftResponse).toContain("USPS under tracking number 9400111899223197428490");
    expect(out.kind === "analyzed" && out.view.analysis?.aiUnavailable).toBe(true);
  });

  it("budget spent: same outcome as no model, and the budget is not touched further", async () => {
    const { repo, fetchImpl, deps } = setup({ llm: { checkBudget: async () => ({ allowed: false, reason: "session" }) } });
    await analyzeDispute(DISPUTE_ID, SESSION, deps);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.saves[0]).toMatchObject({ winProbability: null, finalRecommendation: "contest" });
  });

  it("an invalid model answer falls back for that step only: a good analysis is kept when only the draft fails", async () => {
    const { repo, fetchImpl, deps } = setup();
    fetchImpl.mockResolvedValueOnce(toolCallResponse(GOOD, "dispute_analysis")).mockResolvedValueOnce(toolCallResponse({ response_text: "word ".repeat(500) }, "dispute_draft_response"));
    await analyzeDispute(DISPUTE_ID, SESSION, deps);
    expect(repo.saves[0]).toMatchObject({ winProbability: 0.95, recommendationSource: "system" });
    expect(repo.saves[0]?.draftResponse).toContain("USPS under tracking number"); // the factual template, not 500 words of padding
  });

  it("stores the order's risk score as the snapshot", async () => {
    const { repo, deps } = setup({ llm: { isConfigured: () => false } });
    await analyzeDispute(DISPUTE_ID, SESSION, deps);
    expect(repo.saves[0]?.riskScoreSnapshot).toBe(12);
  });
});

describe("analyzeDispute: concurrency", () => {
  it("the loser of a double-click discards its result and returns the winner's", async () => {
    const { repo, deps } = setup({ llm: { isConfigured: () => false } });
    repo.loseNextSave({
      baseWinProbability: 1, llmAdjustment: 0, winProbability: 0.95, winLikelihoodLabel: "Strong", systemRecommendation: "contest",
      overrideRecommendation: null, finalRecommendation: "contest", recommendationSource: "system", reasoning: "WINNER", evidenceUsed: [], evidenceGaps: [],
      draftResponse: "WINNER DRAFT", analysisComputedAt: "2026-11-08T11:59:00.000Z", riskScoreSnapshot: 0,
    });

    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);

    expect(out.kind).toBe("cached");
    expect(out.kind === "cached" && out.view.analysis?.reasoning).toBe("WINNER");
    expect(repo.records[0]?.dispute.reasoning).toBe("WINNER");
  });
});

describe("analyzeDispute: activity log", () => {
  it("logs the rule engine, the model attempts and the save against the dispute and session, without secrets or PII", async () => {
    const { deps, fetchImpl, logs, llmLogs } = setup();
    fetchImpl.mockResolvedValueOnce(toolCallResponse(GOOD, "dispute_analysis")).mockResolvedValueOnce(toolCallResponse({ response_text: DRAFT }, "dispute_draft_response"));

    await analyzeDispute(DISPUTE_ID, SESSION, deps);

    expect(logs.map((l) => `${l.stepType}:${l.toolName}:${l.status}`)).toEqual(["rule_engine:assess_dispute:success", "rule_engine:save_analysis:success"]);
    expect(logs.every((l) => l.refDisputeId === DISPUTE_ID && l.sessionId === SESSION)).toBe(true);
    expect(llmLogs.map((l) => `${l.toolName}:${l.status}`)).toEqual(["dispute_analysis:success", "dispute_draft_response:success"]);
    const text = JSON.stringify([logs, llmLogs]);
    for (const secret of [PRIMARY_KEY, BUYER_EMAIL, "never received", "PRIVATE MESSAGE TEXT", "<instructions>"]) expect(text).not.toContain(secret);
  });

  it("the fallback is logged as 'fallback', and a logger that throws changes nothing", async () => {
    const { deps, logs, repo } = setup({ llm: { isConfigured: () => false } });
    await analyzeDispute(DISPUTE_ID, SESSION, deps);
    expect(logs.at(-1)).toMatchObject({ toolName: "save_analysis", status: "fallback" });

    const broken = setup({ llm: { isConfigured: () => false } });
    const out = await analyzeDispute(DISPUTE_ID, SESSION, { ...broken.deps, log: async () => { throw new Error("log table is down"); } });
    expect(out.kind).toBe("analyzed");
    expect(broken.repo.saves).toHaveLength(1);
    expect(repo.saves).toHaveLength(1);
  });

  it("provider failures are logged per attempt and the analysis still completes", async () => {
    const { deps, fetchImpl, llmLogs, repo } = setup();
    fetchImpl.mockResolvedValue(errorResponse(503));
    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);
    expect(out.kind === "analyzed" && out.usedFallback).toBe(true);
    expect(llmLogs.some((l) => l.status === "error")).toBe(true);
    expect(repo.saves).toHaveLength(1);
  });
});
