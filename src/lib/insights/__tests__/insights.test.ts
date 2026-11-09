import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InsightsCacheRow, SignalWeights } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { GEMINI, mockFetch, requestBody, toolCallResponse } from "@/lib/ai/__tests__/fixtures";
import { AI_UNAVAILABLE_NOTE } from "@/lib/format";
import { toSignalWeightValues } from "@/lib/orders/weights";
import { DEFAULT_SIGNAL_WEIGHTS, computeRiskScore, evaluateSignals, type SignalWeightValues } from "@/lib/scoring";
import { SEED_PROPOSAL_REASONING, buildSeedBundle } from "@/seed/data";
import { approveWeights, rejectWeights } from "../decide";
import { currentFingerprint } from "../fingerprint";
import { loadInsights } from "../read";
import { INSIGHTS_CACHE_ID } from "../repo";
import { regenerateInsightsSummaryIfStale, type SummaryDeps } from "../summary";
import { NOW, WEIGHTS_ID, createFakeInsightsRepo, fakeLlmDeps, makeOutcome, withProposal, type FakeInsightsRepo, type FakeOutcome } from "./fakes";

const SESSION = "session-a";
const weights = (over: Partial<SignalWeightValues> = {}): SignalWeightValues => ({ ...DEFAULT_SIGNAL_WEIGHTS, ...over });
const SUMMARY_TEXT = "Two disputes were won and one was lost. Nothing changes until you approve the pending change.";

function summarySetup(init: Parameters<typeof createFakeInsightsRepo>[0] = {}, llmOver: Parameters<typeof fakeLlmDeps>[0] = {}) {
  const repo = createFakeInsightsRepo(init);
  const fetchImpl = mockFetch().mockImplementation(async () => toolCallResponse({ summary: SUMMARY_TEXT }, "insights_summary"));
  const llm = fakeLlmDeps(llmOver);
  const deps: SummaryDeps = { repo, ai: { llm, getProviders: () => [GEMINI], fetchImpl }, now: () => NOW };
  return { repo, fetchImpl, llm, deps };
}

const outcomes = (n: number): FakeOutcome[] => Array.from({ length: n }, (_, i) => makeOutcome(i + 1, { outcome: i % 3 === 0 ? "lost" : "won" }));

describe("regenerateInsightsSummaryIfStale", () => {
  it("with no cached summary: exactly one model call (insights_summary pinned), then the cache holds it with the current fingerprint", async () => {
    const { repo, deps, fetchImpl, llm } = summarySetup({ outcomes: outcomes(5) });
    const result = await regenerateInsightsSummaryIfStale(SESSION, deps);

    expect(result).toEqual({ kind: "regenerated", usedFallback: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(llm.checkBudget).toHaveBeenCalledTimes(1);
    expect(llm.checkBudget).toHaveBeenCalledWith(SESSION);
    expect(requestBody(fetchImpl, 0).tool_choice).toEqual({ type: "function", function: { name: "insights_summary" } });
    expect(repo.cache).toMatchObject({ id: INSIGHTS_CACHE_ID, summary: SUMMARY_TEXT, usedFallback: false, generatedAt: NOW.toISOString() });
    expect(repo.cache?.inputFingerprint).toBe(currentFingerprint(await repo.getOutcomeStats(), repo.weights));
  });

  it("an unchanged fingerprint makes 0 model calls and writes nothing (twice in a row)", async () => {
    const { repo, deps, fetchImpl, llm } = summarySetup({ outcomes: outcomes(5) });
    await regenerateInsightsSummaryIfStale(SESSION, deps);
    fetchImpl.mockClear();
    llm.checkBudget.mockClear();
    const writes = repo.writes.upsertCache;

    expect(await regenerateInsightsSummaryIfStale(SESSION, deps)).toEqual({ kind: "fresh" });
    expect(await regenerateInsightsSummaryIfStale(SESSION, deps)).toEqual({ kind: "fresh" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
    expect(repo.writes.upsertCache).toBe(writes);
  });

  it("an outcome insert followed by regenerate makes exactly one call", async () => {
    const { repo, deps, fetchImpl } = summarySetup({ outcomes: outcomes(5) });
    await regenerateInsightsSummaryIfStale(SESSION, deps);
    fetchImpl.mockClear();

    repo.outcomes.push(makeOutcome(6, { outcome: "refunded" })); // a new outcome row
    expect((await regenerateInsightsSummaryIfStale(SESSION, deps)).kind).toBe("regenerated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await regenerateInsightsSummaryIfStale(SESSION, deps)).kind).toBe("fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a proposal is created", (r: FakeInsightsRepo) => void Object.assign(r.weights, withProposal(weights({ rush_shipping: 12 }), "2026-11-08T11:00:00.000Z"))],
    ["a proposal is approved", (r: FakeInsightsRepo) => void Object.assign(r.weights, { rushShipping: 12 })],
    ["a proposal is rejected", (r: FakeInsightsRepo) => void Object.assign(r.weights, { proposalCreatedAt: null })],
  ])("when %s the fingerprint changes and the next regenerate makes one call", async (_name, change) => {
    const { repo, deps, fetchImpl } = summarySetup({ outcomes: outcomes(5), weights: withProposal(weights({ rush_shipping: 12 }), "2026-11-07T00:00:00.000Z") });
    await regenerateInsightsSummaryIfStale(SESSION, deps);
    fetchImpl.mockClear();
    change(repo);
    expect((await regenerateInsightsSummaryIfStale(SESSION, deps)).kind).toBe("regenerated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the model unavailable (no key): the rule-based summary is cached as a fallback, with no network call, and not retried on the same data", async () => {
    const { repo, deps, fetchImpl } = summarySetup({ outcomes: outcomes(5) }, { isConfigured: () => false });
    expect(await regenerateInsightsSummaryIfStale(SESSION, deps)).toEqual({ kind: "regenerated", usedFallback: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.cache?.usedFallback).toBe(true);
    expect(repo.cache?.summary).toContain("Of the 5 resolved disputes");
    expect((await regenerateInsightsSummaryIfStale(SESSION, deps)).kind).toBe("fresh");
  });

  it("an invalid model answer (too many words) is cached as the rule-based fallback", async () => {
    const { repo, deps } = summarySetup({ outcomes: outcomes(3) });
    (deps.ai.fetchImpl as ReturnType<typeof mockFetch>).mockImplementation(async () => toolCallResponse({ summary: Array.from({ length: 200 }, () => "word").join(" ") }, "insights_summary"));
    expect(await regenerateInsightsSummaryIfStale(SESSION, deps)).toEqual({ kind: "regenerated", usedFallback: true });
    expect(repo.cache?.summary).toContain("Of the 3 resolved disputes");
  });

  it("does nothing without an active weights row", async () => {
    const { deps, repo, fetchImpl } = summarySetup({ weights: { isActive: false } });
    expect(await regenerateInsightsSummaryIfStale(SESSION, deps)).toEqual({ kind: "no_weights" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.writes.upsertCache).toBe(0);
  });
});

describe("the seeded insights_cache matches the app's fingerprint (zero model calls on first load)", () => {
  function seededRepo() {
    const bundle = buildSeedBundle(NOW);
    const seeded: FakeOutcome[] = bundle.outcomes.map((o, i) => makeOutcome(i + 1, { id: o.id!, outcome: o.outcome, createdAt: o.createdAt!, seeded: true }));
    return createFakeInsightsRepo({ weights: bundle.weights as SignalWeights, outcomes: seeded, cache: bundle.insights as InsightsCacheRow });
  }

  it("regenerate on the seeded state is a cache hit", async () => {
    const repo = seededRepo();
    const fetchImpl = mockFetch();
    const llm = fakeLlmDeps();
    const result = await regenerateInsightsSummaryIfStale(SESSION, { repo, ai: { llm, getProviders: () => [GEMINI], fetchImpl } });
    expect(result).toEqual({ kind: "fresh" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
  });

  it("the Insights read model serves the seeded summary as cached, not as a fallback", async () => {
    const view = await loadInsights(seededRepo());
    expect(view?.summary).toMatchObject({ source: "cached", usedFallback: false, note: null });
    expect(view?.summary.text).toContain("Of the 5 resolved disputes");
  });
});

describe("loadInsights (GET /api/insights never calls a model)", () => {
  it("returns weights with their delta against the baseline, in the fixed signal order", async () => {
    const repo = createFakeInsightsRepo({ weights: { rushShipping: 12, countryMismatch: 23 }, outcomes: outcomes(3) });
    const view = await loadInsights(repo);
    expect(view?.weights.map((w) => [w.signal, w.current, w.baseline, w.delta])).toEqual([
      ["country_mismatch", 23, 20, 3],
      ["first_time_high_value", 20, 20, 0],
      ["rush_shipping", 12, 15, -3],
      ["high_relative_value", 20, 20, 0],
      ["disposable_email", 15, 15, 0],
      ["repeated_attempts", 10, 10, 0],
    ]);
    expect(view?.weights[0]?.label).toBe("Billing and shipping countries differ");
  });

  it("the outcome breakdown counts won / lost / refunded and the simulated and seeded ones", async () => {
    const repo = createFakeInsightsRepo({
      outcomes: [makeOutcome(1, { outcome: "won", seeded: true }), makeOutcome(2, { outcome: "lost", seeded: true }), makeOutcome(3, { outcome: "refunded", isSimulated: true }), makeOutcome(4, { outcome: "won", isSimulated: true })],
    });
    expect((await loadInsights(repo))?.outcomes).toEqual({ total: 4, won: 2, lost: 1, refunded: 1, simulated: 2, seeded: 2, includesDemoData: true });
  });

  it("shows the pending proposal with all six signals and the delta against the live weight", async () => {
    const repo = createFakeInsightsRepo({ weights: withProposal(weights({ first_time_high_value: 23 }), "2026-11-07T12:00:00.000Z", "Because of the loss.") });
    const view = await loadInsights(repo);
    expect(view?.proposal).toMatchObject({ createdAt: "2026-11-07T12:00:00.000Z", reasoning: "Because of the loss.", isDemo: false });
    expect(view?.proposal?.changes).toHaveLength(6);
    expect(view?.proposal?.changes.find((c) => c.signal === "first_time_high_value")).toMatchObject({ current: 20, proposed: 23, delta: 3 });
    expect(view?.progress.proposalPending).toBe(true);
  });

  it("flags the seeded proposal as demo data, and no proposal as null", async () => {
    const seeded = createFakeInsightsRepo({ weights: withProposal(weights({ first_time_high_value: 23 }), "2026-11-07T12:00:00.000Z", SEED_PROPOSAL_REASONING) });
    expect((await loadInsights(seeded))?.proposal?.isDemo).toBe(true);
    expect((await loadInsights(createFakeInsightsRepo()))?.proposal).toBeNull();
  });

  it("progress: how many more resolved disputes until a proposal is considered", async () => {
    const view = await loadInsights(createFakeInsightsRepo({ weights: { resolvedSinceLastProposal: 3 } }));
    expect(view?.progress).toEqual({ resolved: 3, every: 5, remaining: 2, proposalPending: false });
  });

  it("a fresh cached AI summary is shown as is; a fallback one carries the AI-unavailable note", async () => {
    const fresh = summarySetup({ outcomes: outcomes(4) });
    await regenerateInsightsSummaryIfStale(SESSION, fresh.deps);
    expect((await loadInsights(fresh.repo))?.summary).toMatchObject({ text: SUMMARY_TEXT, usedFallback: false, note: null, source: "cached" });

    const fallback = summarySetup({ outcomes: outcomes(4) }, { isConfigured: () => false });
    await regenerateInsightsSummaryIfStale(SESSION, fallback.deps);
    expect((await loadInsights(fallback.repo))?.summary).toMatchObject({ usedFallback: true, note: AI_UNAVAILABLE_NOTE, source: "cached" });
  });

  it("a missing or out-of-date cache shows a rule-based summary of the CURRENT data with the note, never a stale AI text", async () => {
    const missing = await loadInsights(createFakeInsightsRepo({ outcomes: outcomes(4) }));
    expect(missing?.summary).toMatchObject({ source: "rule_based", usedFallback: true, note: AI_UNAVAILABLE_NOTE, generatedAt: null });
    expect(missing?.summary.text).toContain("Of the 4 resolved disputes");

    const { repo, deps } = summarySetup({ outcomes: outcomes(4) });
    await regenerateInsightsSummaryIfStale(SESSION, deps);
    repo.outcomes.push(makeOutcome(5)); // the data moved on; nothing refreshed the cache yet
    const stale = await loadInsights(repo);
    expect(stale?.summary).toMatchObject({ source: "rule_based", note: AI_UNAVAILABLE_NOTE });
    expect(stale?.summary.text).toContain("Of the 5 resolved disputes");
    expect(stale?.summary.text).not.toBe(SUMMARY_TEXT);
  });

  it("two consecutive loads make 0 model calls (the read model has no way to reach one)", async () => {
    const { repo, fetchImpl, llm } = summarySetup({ outcomes: outcomes(5) });
    await loadInsights(repo);
    await loadInsights(repo);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
    expect(llm.logActivity).not.toHaveBeenCalled();
    expect(repo.writes).toEqual({ storeProposal: 0, resetCounter: 0, applyProposal: 0, rejectProposal: 0, upsertCache: 0 });
  });

  it("is null without an active weights row", async () => {
    expect(await loadInsights(createFakeInsightsRepo({ weights: { isActive: false } }))).toBeNull();
  });
});

describe("the GET route and the read model cannot reach a model (structural)", () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, "..", "..", "..", "..", ...parts), "utf8");
  const importsOf = (text: string) => Array.from(text.matchAll(/from\s+["']([^"']+)["']/g)).map((m) => m[1]!);
  const FORBIDDEN = /(^|\/)ai\/|getLlmDeps|insights\/(runtime|summary|loop|decide)(?![-\w])|^\.\/(summary|loop|decide|runtime)$/;

  it.each([
    ["src/app/api/insights/route.ts"],
    ["src/lib/insights/read.ts"],
    ["src/app/(app)/insights/page.tsx"],
  ])("%s imports nothing from the AI layer, the summary refresh or the learning loop", (file) => {
    const text = read(...file.split("/"));
    expect(importsOf(text).filter((i) => FORBIDDEN.test(i)), file).toEqual([]);
  });
});

describe("approve / reject the pending proposal (merchant decisions)", () => {
  const AT = "2026-11-07T12:00:00.000Z";
  const proposed = weights({ first_time_high_value: 23, rush_shipping: 12 });

  function decideSetup(counter = 7) {
    const repo = createFakeInsightsRepo({ weights: { ...withProposal(proposed, AT), resolvedSinceLastProposal: counter } });
    const logs: ActivityMeta[] = [];
    return { repo, logs, deps: { repo, log: async (m: ActivityMeta) => void logs.push(m) } };
  }

  it("approve: the proposed weights become the live ones, the proposal is cleared, the counter resets, and it is logged as a merchant action", async () => {
    const { repo, deps, logs } = decideSetup();
    expect(await approveWeights({ sessionId: SESSION, proposalCreatedAt: AT }, deps)).toEqual({ kind: "applied", changes: 2 });

    expect(toSignalWeightValues(repo.weights)).toEqual(proposed);
    expect(repo.weights).toMatchObject({ proposalCreatedAt: null, proposalReasoning: null, proposedFirstTimeHighValue: null, proposedRushShipping: null, resolvedSinceLastProposal: 0 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ stepType: "merchant_action", toolName: "approve_weight_change", status: "success", sessionId: SESSION });
    expect(logs[0]?.inputSummary).toContain("first_time_high_value 20->23");
  });

  it("approved weights change the score of orders scored from then on, and only those", async () => {
    // A first-time buyer, $300, rush shipping, same country: first-time high value 20 + rush 15 + high relative value 20.
    const order = { buyerEmail: "a@example.com", buyerIsFirstTime: true, paymentAttemptCount: 1, shippingMethod: "rush", billingCountry: "US", shippingCountry: "US", amountUsd: 300 };
    const score = (w: SignalWeightValues) => computeRiskScore(evaluateSignals(order, w, 85));
    const repo = createFakeInsightsRepo({ weights: withProposal(weights({ first_time_high_value: 23 }), AT) });
    const stored = score(toSignalWeightValues(repo.weights)); // the scoring engine reads the ACTIVE row only
    expect(stored).toBe(55); // a pending proposal changes nothing by itself

    await approveWeights({ sessionId: SESSION, proposalCreatedAt: AT }, { repo });
    expect(score(toSignalWeightValues(repo.weights))).toBe(58); // +3 on first-time high value
  });

  it("reject: the proposal is cleared, the live weights are untouched and the counter is NOT reset", async () => {
    const { repo, deps, logs } = decideSetup(7);
    expect(await rejectWeights({ sessionId: SESSION, proposalCreatedAt: AT }, deps)).toEqual({ kind: "rejected" });
    expect(toSignalWeightValues(repo.weights)).toEqual(DEFAULT_SIGNAL_WEIGHTS);
    expect(repo.weights).toMatchObject({ proposalCreatedAt: null, proposedFirstTimeHighValue: null, resolvedSinceLastProposal: 7 });
    expect(logs[0]).toMatchObject({ stepType: "merchant_action", toolName: "reject_weight_change" });
  });

  it("deciding twice is safe: the second call finds no proposal and changes nothing", async () => {
    const { repo, deps, logs } = decideSetup();
    await approveWeights({ sessionId: SESSION, proposalCreatedAt: AT }, deps);
    const after = { ...repo.weights };
    expect(await approveWeights({ sessionId: SESSION, proposalCreatedAt: AT }, deps)).toEqual({ kind: "no_proposal" });
    expect(await rejectWeights({ sessionId: SESSION, proposalCreatedAt: AT }, deps)).toEqual({ kind: "no_proposal" });
    expect(repo.weights).toEqual(after);
    expect(logs).toHaveLength(1);
  });

  it("a merchant can only decide the proposal they were shown", async () => {
    const { repo, deps, logs } = decideSetup();
    expect(await approveWeights({ sessionId: SESSION, proposalCreatedAt: "2026-11-01T00:00:00.000Z" }, deps)).toEqual({ kind: "proposal_changed" });
    expect(await rejectWeights({ sessionId: SESSION, proposalCreatedAt: "2026-11-01T00:00:00.000Z" }, deps)).toEqual({ kind: "proposal_changed" });
    expect(repo.weights.proposalCreatedAt).toBe(AT);
    expect(repo.writes.applyProposal + repo.writes.rejectProposal).toBe(0);
    expect(logs).toEqual([]);
  });

  it("with nothing pending: no_proposal; without a weights row: not_seeded", async () => {
    const none = createFakeInsightsRepo();
    expect(await approveWeights({ sessionId: SESSION, proposalCreatedAt: AT }, { repo: none })).toEqual({ kind: "no_proposal" });
    const unseeded = createFakeInsightsRepo({ weights: { isActive: false } });
    expect(await rejectWeights({ sessionId: SESSION, proposalCreatedAt: AT }, { repo: unseeded })).toEqual({ kind: "not_seeded" });
  });

  it("a request that loses the race (the conditional update matches nothing) reports no_proposal and logs nothing", async () => {
    const { repo, logs } = decideSetup();
    const raced = { ...repo, applyProposal: async () => null };
    expect(await approveWeights({ sessionId: SESSION, proposalCreatedAt: AT }, { repo: raced, log: async (m) => void logs.push(m) })).toEqual({ kind: "no_proposal" });
    expect(logs).toEqual([]);
  });

  it("a logger that throws never breaks the decision", async () => {
    const { repo } = decideSetup();
    const result = await approveWeights({ sessionId: SESSION, proposalCreatedAt: AT }, { repo, log: async () => { throw new Error("log table is down"); } });
    expect(result.kind).toBe("applied");
  });
});

void WEIGHTS_ID;
