import { describe, expect, it } from "vitest";
import type { ActivityMeta } from "@/lib/activity/logger";
import { CAPPED_NOTE } from "@/lib/ai/insights";
import { GEMINI, mockFetch, requestBody, toolCallResponse } from "@/lib/ai/__tests__/fixtures";
import { DEFAULT_SIGNAL_WEIGHTS, type SignalWeightValues } from "@/lib/scoring";
import { runLearningLoop, type LoopDeps } from "../loop";
import type { InsightsRepo } from "../types";
import { NOW, WEIGHTS_ID, createFakeInsightsRepo, fakeLlmDeps, makeOutcome, withProposal, type FakeInsightsRepo, type FakeOutcome } from "./fakes";

const SESSION = "session-a";
const event = (counterAfter: number | null) => ({ sessionId: SESSION, disputeId: "dispute-1", counterAfter });
const weights = (over: Partial<SignalWeightValues> = {}): SignalWeightValues => ({ ...DEFAULT_SIGNAL_WEIGHTS, ...over });

/** Five resolved disputes like the demo history: two wins, one loss on a first-time high-value order, two refunds. */
const HISTORY: FakeOutcome[] = [
  makeOutcome(1, { outcome: "won", seeded: true }),
  makeOutcome(2, { outcome: "won", seeded: true, activeSignals: ["rush_shipping"] }),
  makeOutcome(3, { outcome: "lost", seeded: true, reason: "not_as_described", amountUsd: 210, riskScore: 55, verdict: "verify", activeSignals: ["first_time_high_value", "country_mismatch"] }),
  makeOutcome(4, { outcome: "refunded", seeded: true, amountUsd: 38 }),
  makeOutcome(5, { outcome: "refunded", seeded: true, amountUsd: 42 }),
];

/** The model's answer to the weight_proposal tool. */
const proposal = (proposed: SignalWeightValues, reasoning = "The only loss came from a first-time high-value order, so that signal deserves slightly more weight. Five outcomes is a small sample.") => ({
  proposed_weights: proposed,
  reasoning,
});

function setup(repoInit: Parameters<typeof createFakeInsightsRepo>[0] = {}, answer: unknown = proposal(weights({ first_time_high_value: 23 })), llmOver: Parameters<typeof fakeLlmDeps>[0] = {}) {
  const repo = createFakeInsightsRepo({ outcomes: HISTORY, ...repoInit });
  const fetchImpl = mockFetch().mockImplementation(async () => toolCallResponse(answer, "weight_proposal"));
  const llm = fakeLlmDeps(llmOver);
  const logs: ActivityMeta[] = [];
  const deps: LoopDeps = { repo, ai: { llm, getProviders: () => [GEMINI], fetchImpl }, now: () => NOW, log: async (m) => void logs.push(m) };
  return { repo, fetchImpl, llm, logs, deps };
}

const proposedOf = (repo: FakeInsightsRepo) => ({
  at: repo.weights.proposalCreatedAt,
  first: repo.weights.proposedFirstTimeHighValue,
  counter: repo.weights.resolvedSinceLastProposal,
});

describe("runLearningLoop: when it is due", () => {
  it.each([null, 0, 1, 2, 3, 4, 6, 7, 9, 11])("counter %s: nothing happens (no model call, no write, no log)", async (counter) => {
    const { repo, deps, fetchImpl, llm, logs } = setup({ weights: { resolvedSinceLastProposal: counter ?? 0 } });
    expect(await runLearningLoop(event(counter), deps)).toEqual({ kind: "not_due" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
    expect(Object.values(repo.writes).every((n) => n === 0)).toBe(true);
    expect(logs).toEqual([]);
  });

  it("uses the counter value of THIS outcome, not whatever the row holds by the time it runs", async () => {
    // Two outcomes landed back to back: the row already says 6, but this event's bump produced 5.
    const { repo, deps } = setup({ weights: { resolvedSinceLastProposal: 6 } });
    expect((await runLearningLoop(event(5), deps)).kind).toBe("proposed");
    expect(proposedOf(repo).counter).toBe(0);
  });
});

describe("runLearningLoop: the 5th outcome with no proposal pending", () => {
  it("asks the model once (weight_proposal pinned), stores the capped proposal as pending and resets the counter", async () => {
    const { repo, deps, fetchImpl, llm, logs } = setup({ weights: { resolvedSinceLastProposal: 5 } });
    const result = await runLearningLoop(event(5), deps);

    expect(result).toEqual({ kind: "proposed", changes: 1, capped: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(llm.checkBudget).toHaveBeenCalledTimes(1);
    expect(llm.checkBudget).toHaveBeenCalledWith(SESSION);
    const body = requestBody(fetchImpl, 0);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "weight_proposal" } });
    expect(body.tools).toHaveLength(1);

    // Pending, not applied: the live weight is untouched.
    expect(repo.weights.firstTimeHighValue).toBe(20);
    expect(proposedOf(repo)).toEqual({ at: NOW.toISOString(), first: 23, counter: 0 });
    expect(repo.weights.proposalReasoning).toContain("first-time high-value");
    expect(logs.map((l) => [l.stepType, l.toolName, l.status])).toEqual([["rule_engine", "weight_proposal_created", "success"]]);
  });

  it("puts the current weights and the recent outcomes in the <data> section, and no buyer details", async () => {
    const { deps, fetchImpl } = setup({ weights: { resolvedSinceLastProposal: 5 } });
    await runLearningLoop(event(5), deps);
    const prompt = requestBody(fetchImpl, 0).messages.at(-1)!.content;
    expect(prompt).toContain('<weight signal="first_time_high_value" current="20" />');
    expect(prompt).toContain('<recent_outcomes count="5">');
    expect(prompt).toContain('result="lost" dispute_reason="not_as_described" amount_usd="210.00" risk_score="55" verdict="verify"');
    expect(prompt).toContain('active_signals="first_time_high_value,country_mismatch"');
    expect(prompt).not.toMatch(/\S+@\S+|buyer_message|buyer_email/i); // no address, no buyer text
    expect(prompt.indexOf("<instructions>")).toBeLessThan(prompt.indexOf("<data>"));
  });

  it("sends at most the 20 most recent outcomes, newest first", async () => {
    const many = Array.from({ length: 30 }, (_, i) => makeOutcome(i + 1, { amountUsd: 1000 + i }));
    const { deps, fetchImpl } = setup({ outcomes: many, weights: { resolvedSinceLastProposal: 5 } });
    await runLearningLoop(event(5), deps);
    const prompt = requestBody(fetchImpl, 0).messages.at(-1)!.content;
    expect(prompt).toContain('<recent_outcomes count="20">');
    expect(prompt).toContain('amount_usd="1029.00"'); // the newest
    expect(prompt).toContain('amount_usd="1010.00"'); // the 20th newest
    expect(prompt).not.toContain('amount_usd="1009.00"');
  });

  it("caps the model's answer: +10 becomes +3, 40 becomes 23, 1 becomes 12, and the reasoning says so", async () => {
    const answer = proposal(weights({ first_time_high_value: 30, country_mismatch: 40, disposable_email: 1 }));
    const { repo, deps } = setup({ weights: { resolvedSinceLastProposal: 5 } }, answer);
    expect(await runLearningLoop(event(5), deps)).toEqual({ kind: "proposed", changes: 3, capped: true });
    expect(repo.weights).toMatchObject({ proposedFirstTimeHighValue: 23, proposedCountryMismatch: 23, proposedDisposableEmail: 12 });
    expect(repo.weights.proposalReasoning).toContain(CAPPED_NOTE.trim());
  });

  it("a weight already at 30 or 5 stays in range", async () => {
    const answer = proposal(weights({ rush_shipping: 40, repeated_attempts: 1 }));
    const { repo, deps } = setup({ weights: { resolvedSinceLastProposal: 5, rushShipping: 30, repeatedAttempts: 5 } }, answer);
    expect((await runLearningLoop(event(5), deps)).kind).toBe("no_change"); // 30 stays 30, 5 stays 5
    expect(repo.weights.proposalCreatedAt).toBeNull();
  });
});

describe("runLearningLoop: a proposal is already pending (REQ-LL-02)", () => {
  const pending = withProposal(weights({ first_time_high_value: 23 }));

  it("the 5th outcome logs proposal_skipped_pending, makes no model call and does NOT reset the counter", async () => {
    const { repo, deps, fetchImpl, llm, logs } = setup({ weights: { ...pending, resolvedSinceLastProposal: 5 } });
    expect(await runLearningLoop(event(5), deps)).toEqual({ kind: "skipped_pending" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.checkBudget).not.toHaveBeenCalled();
    expect(llm.logActivity).not.toHaveBeenCalled();
    expect(repo.weights.resolvedSinceLastProposal).toBe(5);
    expect(repo.weights.proposalReasoning).toBe("Because."); // the existing proposal is untouched
    expect(Object.values(repo.writes).every((n) => n === 0)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ stepType: "rule_engine", toolName: "proposal_skipped_pending", status: "success" });
  });

  it("keeps counting: 6..9 do nothing and the 10th skips again, with the counter never reset", async () => {
    const { repo, deps, fetchImpl, logs } = setup({ weights: { ...pending, resolvedSinceLastProposal: 5 } });
    for (const counter of [5, 6, 7, 8, 9, 10]) {
      repo.weights.resolvedSinceLastProposal = counter; // the counter the real bump would have produced
      await runLearningLoop(event(counter), deps);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.map((l) => l.toolName)).toEqual(["proposal_skipped_pending", "proposal_skipped_pending"]); // at 5 and at 10
    expect(repo.weights.resolvedSinceLastProposal).toBe(10);
  });

  it("after the merchant rejects it the counter is still where it was, and the next multiple of 5 proposes again", async () => {
    const { repo, deps, fetchImpl } = setup({ weights: { ...pending, resolvedSinceLastProposal: 7 } });
    await repo.rejectProposal(WEIGHTS_ID, pending.proposalCreatedAt!);
    expect(repo.weights.resolvedSinceLastProposal).toBe(7);
    repo.weights.resolvedSinceLastProposal = 10;
    expect((await runLearningLoop(event(10), deps)).kind).toBe("proposed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("two requests racing to store: the loser's proposal is dropped, the winner's stays", async () => {
    const { repo, deps } = setup({ weights: { resolvedSinceLastProposal: 5 } });
    const racing: InsightsRepo = { ...repo, storeProposal: async () => false };
    const result = await runLearningLoop(event(5), { ...deps, repo: racing });
    expect(result).toEqual({ kind: "skipped_pending" });
    expect(repo.writes.storeProposal).toBe(0);
  });
});

describe("runLearningLoop: the model is unavailable or says nothing needs to change", () => {
  it("no LLM key: no proposal is stored, the weights and counter are unchanged, and it is logged as a fallback", async () => {
    const { repo, deps, fetchImpl, logs } = setup({ weights: { resolvedSinceLastProposal: 5 } }, undefined, { isConfigured: () => false });
    expect(await runLearningLoop(event(5), deps)).toEqual({ kind: "ai_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.weights).toMatchObject({ proposalCreatedAt: null, resolvedSinceLastProposal: 5, firstTimeHighValue: 20 });
    expect(logs.map((l) => [l.toolName, l.status])).toEqual([["proposal_skipped_ai_unavailable", "fallback"]]);
  });

  it("budget spent: same, and the model is not called", async () => {
    const { repo, deps, fetchImpl } = setup({ weights: { resolvedSinceLastProposal: 5 } }, undefined, { checkBudget: async () => ({ allowed: false, reason: "daily" as const }) });
    expect((await runLearningLoop(event(5), deps)).kind).toBe("ai_unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repo.weights.proposalCreatedAt).toBeNull();
  });

  it.each([
    ["a weight outside the schema range", { proposed_weights: weights({ rush_shipping: 99 }), reasoning: "ok" }],
    ["a fractional weight", { proposed_weights: { ...weights(), rush_shipping: 14.5 }, reasoning: "ok" }],
    ["a missing signal", { proposed_weights: { country_mismatch: 20 }, reasoning: "ok" }],
    ["an empty reasoning", { proposed_weights: weights(), reasoning: "" }],
    ["reasoning over 150 words", { proposed_weights: weights(), reasoning: Array.from({ length: 160 }, () => "word").join(" ") }],
  ])("an answer with %s fails validation: nothing is stored", async (_name, answer) => {
    const { repo, deps } = setup({ weights: { resolvedSinceLastProposal: 5 } }, answer);
    expect((await runLearningLoop(event(5), deps)).kind).toBe("ai_unavailable");
    expect(repo.weights).toMatchObject({ proposalCreatedAt: null, resolvedSinceLastProposal: 5 });
  });

  it("an answer that keeps every weight: nothing to approve, so no proposal is stored, but the cycle is consumed (counter reset)", async () => {
    const { repo, deps, logs } = setup({ weights: { resolvedSinceLastProposal: 5 } }, proposal(weights()));
    expect(await runLearningLoop(event(5), deps)).toEqual({ kind: "no_change" });
    expect(repo.weights).toMatchObject({ proposalCreatedAt: null, resolvedSinceLastProposal: 0 });
    expect(logs.map((l) => l.toolName)).toEqual(["proposal_no_change"]);
  });

  it("a logger that throws never breaks the loop", async () => {
    const { repo, deps } = setup({ weights: { resolvedSinceLastProposal: 5 } });
    const result = await runLearningLoop(event(5), { ...deps, log: async () => { throw new Error("log table is down"); } });
    expect(result.kind).toBe("proposed");
    expect(repo.weights.proposalCreatedAt).not.toBeNull();
  });
});
