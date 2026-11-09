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

// ---------------------------------------------------------------------------
// In-flight guard (fix 3): simultaneous requests spend one analysis, not several
// ---------------------------------------------------------------------------
describe("analyzeDispute: in-flight guard", () => {
  /** Model answers for one full analysis (analysis + draft), repeated if asked for more. */
  const answerOnce = (fetchImpl: ReturnType<typeof setup>["fetchImpl"]) =>
    fetchImpl.mockResolvedValueOnce(toolCallResponse(GOOD, "dispute_analysis")).mockResolvedValueOnce(toolCallResponse({ response_text: DRAFT }, "dispute_draft_response"));
  const quick = { sleep: () => new Promise<void>((r) => setTimeout(r, 2)), pollMs: 2 };

  it("two simultaneous requests: ONE analysis is paid for, the loser returns the winner's saved result", async () => {
    const { repo, llm, fetchImpl, deps } = setup();
    answerOnce(fetchImpl);

    const [a, b] = await Promise.all([analyzeDispute(DISPUTE_ID, SESSION, { ...deps, ...quick }), analyzeDispute(DISPUTE_ID, SESSION, { ...deps, ...quick })]);

    expect([a.kind, b.kind].sort()).toEqual(["analyzed", "cached"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // exactly one analysis + one draft; the loser made no model call
    expect(llm.checkBudget).toHaveBeenCalledTimes(2); // budget units: the same as a single request
    expect(repo.claimsWon).toBe(1);
    expect(repo.saves).toHaveLength(1);
    const reasoning = (o: typeof a) => (o.kind === "analyzed" || o.kind === "cached" ? o.view.analysis?.reasoning : null);
    expect(reasoning(a)).toBe(GOOD.reasoning);
    expect(reasoning(b)).toBe(GOOD.reasoning);
  });

  it("five simultaneous requests: one analysed, four cached, one analysis' worth of model calls", async () => {
    const { repo, llm, fetchImpl, deps } = setup();
    answerOnce(fetchImpl);

    const results = await Promise.all(Array.from({ length: 5 }, () => analyzeDispute(DISPUTE_ID, SESSION, { ...deps, ...quick })));

    expect(results.filter((r) => r.kind === "analyzed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "cached")).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(llm.checkBudget).toHaveBeenCalledTimes(2);
    expect(repo.claimsWon).toBe(1);
  });

  it("the budget used by N simultaneous requests equals the budget used by one request", async () => {
    const one = setup();
    answerOnce(one.fetchImpl);
    await analyzeDispute(DISPUTE_ID, SESSION, { ...one.deps, ...quick });

    const many = setup();
    answerOnce(many.fetchImpl);
    await Promise.all(Array.from({ length: 8 }, () => analyzeDispute(DISPUTE_ID, SESSION, { ...many.deps, ...quick })));

    expect(many.llm.checkBudget.mock.calls.length).toBe(one.llm.checkBudget.mock.calls.length);
    expect(many.fetchImpl.mock.calls.length).toBe(one.fetchImpl.mock.calls.length);
  });

  it("while the winner is working the dispute shows NO analysis (a claim is not an analysis)", async () => {
    const { repo, fetchImpl, deps } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    fetchImpl.mockImplementationOnce(async () => { await gate; return toolCallResponse(GOOD, "dispute_analysis"); }).mockResolvedValueOnce(toolCallResponse({ response_text: DRAFT }, "dispute_draft_response"));

    const winner = analyzeDispute(DISPUTE_ID, SESSION, { ...deps, ...quick });
    await new Promise((r) => setTimeout(r, 10));

    const mid = await repo.findVisible(DISPUTE_ID, SESSION);
    expect(mid?.dispute.analysisComputedAt).toMatch(/^pending:\d{4}-\d{2}-\d{2}T[\d:.]+Z\|/);
    const { toDisputeView } = await import("../read");
    expect(toDisputeView(mid!, NOW).analysis).toBeNull();

    release();
    expect((await winner).kind).toBe("analyzed");
    const done = await repo.findVisible(DISPUTE_ID, SESSION);
    expect(done?.dispute.analysisComputedAt).toBe(NOW.toISOString()); // the claim was replaced by the real timestamp
  });

  it("if the winner fails it releases the claim, and a waiting request takes over and finishes the job", async () => {
    const { repo, fetchImpl, deps } = setup();
    let first = true;
    const original = repo.getArtefacts.bind(repo);
    repo.getArtefacts = async (orderId) => {
      if (first) { first = false; throw new Error("database hiccup"); }
      return original(orderId);
    };
    answerOnce(fetchImpl);

    const [a, b] = await Promise.allSettled([analyzeDispute(DISPUTE_ID, SESSION, { ...deps, ...quick }), analyzeDispute(DISPUTE_ID, SESSION, { ...deps, ...quick })]);

    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const ok = [a, b].find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof analyzeDispute>>> => r.status === "fulfilled")!;
    expect(ok.value.kind).toBe("analyzed");
    expect(repo.releases).toBe(1);
    expect(repo.claimsWon).toBe(2); // the failed winner, then the request that took over
    expect(fetchImpl).toHaveBeenCalledTimes(2); // still only one analysis' worth of model calls
    expect(repo.records[0]?.dispute.analysisComputedAt).toBe(NOW.toISOString());
  });

  it("a failed analysis leaves no claim behind", async () => {
    const { repo, deps } = setup();
    repo.getArtefacts = async () => { throw new Error("boom"); };
    await expect(analyzeDispute(DISPUTE_ID, SESSION, deps)).rejects.toThrow("boom");
    expect(repo.records[0]?.dispute.analysisComputedAt).toBeNull();
  });

  it("a claim older than 90 s is treated as abandoned and taken over", async () => {
    const stale = `pending:${new Date(NOW.getTime() - 91_000).toISOString()}|dead-request`;
    const { repo, fetchImpl, deps } = setup({ dispute: { analysisComputedAt: stale } });
    answerOnce(fetchImpl);

    const out = await analyzeDispute(DISPUTE_ID, SESSION, deps);

    expect(out.kind).toBe("analyzed");
    expect(repo.claimsWon).toBe(1);
    expect(repo.records[0]?.dispute.analysisComputedAt).toBe(NOW.toISOString());
  });

  it("a fresh claim that never finishes: the waiting request makes no model call and answers 'in progress'", async () => {
    const fresh = `pending:${new Date(NOW.getTime() - 5_000).toISOString()}|slow-request`;
    const { repo, llm, fetchImpl, deps } = setup({ dispute: { analysisComputedAt: fresh } });
    let t = NOW.getTime();
    const waited: number[] = [];

    const out = await analyzeDispute(DISPUTE_ID, SESSION, {
      ...deps,
      now: () => new Date(t),
      sleep: async (ms) => { waited.push(ms); t += ms; },
      waitForWinnerMs: 3_000,
      pollMs: 750,
    });

    expect(out).toEqual({ kind: "in_progress" });
    expect(waited.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
    expect(repo.claimsWon).toBe(0);
    expect(repo.records[0]?.dispute.analysisComputedAt).toBe(fresh); // the other request's claim is untouched
  });

  it("an unparseable claim can never be completed, so it is taken over", async () => {
    const { repo, fetchImpl, deps } = setup({ dispute: { analysisComputedAt: "pending:garbage" } });
    answerOnce(fetchImpl);
    expect((await analyzeDispute(DISPUTE_ID, SESSION, deps)).kind).toBe("analyzed");
    expect(repo.claimsWon).toBe(1);
  });

  it("a claim only guards its own dispute", async () => {
    const other = makeRecord(makeDispute({ id: "other-dispute", orderId: ORDER_ID, analysisComputedAt: `pending:${NOW.toISOString()}|someone` }));
    const mine = makeRecord(makeDispute({ disputedAmountUsd: 145 }), { riskScore: 12 });
    const repo = createFakeAnalysisRepo([other, mine], artefactRows(ORDER_ID, SEED_C));
    const fetchImpl = mockFetch();
    answerOnce(fetchImpl);
    const llm = { isConfigured: () => true, checkBudget: async () => ({ allowed: true }), logActivity: async () => undefined };

    const out = await analyzeDispute(DISPUTE_ID, SESSION, { repo, explainer: { llm, getProviders: () => [GEMINI], fetchImpl }, costs: COSTS, now: () => NOW });
    expect(out.kind).toBe("analyzed");
  });
});

describe("analysis claim helpers", () => {
  it("tell a claim from a finished analysis", async () => {
    const { isAnalysed, isClaim, newClaimToken, claimTakenAt, isStaleClaim, CLAIM_STALE_MS } = await import("../analysis-state");
    const token = newClaimToken(NOW, "abc");
    expect(token).toBe(`pending:${NOW.toISOString()}|abc`);
    expect(isClaim(token)).toBe(true);
    expect(isAnalysed(token)).toBe(false);
    expect(isAnalysed(null)).toBe(false);
    expect(isAnalysed("")).toBe(false);
    expect(isAnalysed(NOW.toISOString())).toBe(true);
    expect(claimTakenAt(token)?.toISOString()).toBe(NOW.toISOString());
    expect(claimTakenAt(NOW.toISOString())).toBeNull();
    expect(CLAIM_STALE_MS).toBeGreaterThan(60_000); // longer than any function may run
    expect(isStaleClaim(token, new Date(NOW.getTime() + CLAIM_STALE_MS))).toBe(false);
    expect(isStaleClaim(token, new Date(NOW.getTime() + CLAIM_STALE_MS + 1))).toBe(true);
    expect(isStaleClaim("pending:nonsense", NOW)).toBe(true);
    expect(isStaleClaim(NOW.toISOString(), new Date(NOW.getTime() + 1e9))).toBe(false); // an analysis is never "stale"
  });
});

describe("a claim is not an analysis anywhere else", () => {
  it("approve and reject refuse a dispute whose analysis is still only a claim", async () => {
    const { approveDispute, rejectDispute } = await import("../approve");
    const { createFakeDisputesRepo } = await import("./fakes");
    const claimed = analysed({ analysisComputedAt: `pending:${NOW.toISOString()}|x`, isSeed: false, isDemo: false });
    const repo = createFakeDisputesRepo([makeRecord(claimed)], artefactRows(ORDER_ID, SEED_C));
    const req = { disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "submit_evidence" as const };
    expect(await approveDispute(req, { repo, executor: { paypal: null, demoMode: false } })).toEqual({ kind: "not_analyzed" });
    expect(await rejectDispute(req, { repo })).toEqual({ kind: "not_analyzed" });
    expect(repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 0 });
  });
});
