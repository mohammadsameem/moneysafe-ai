import type { InsightsCacheRow, SignalWeights } from "@/db/schema";
import { DEFAULT_SIGNAL_WEIGHTS, type SignalWeightValues } from "@/lib/scoring";
import { INSIGHTS_CACHE_ID } from "../repo";
import type { InsightsRepo, NewInsightsCache, OutcomeForProposal, OutcomeStats } from "../types";
import type { LlmDeps } from "@/lib/ai/call-with-fallback";
import { vi } from "vitest";

export const WEIGHTS_ID = "99999999-9999-4999-8999-999999999999";
export const NOW = new Date("2026-11-08T12:00:00.000Z");
const ISO = "2026-11-01T00:00:00.000Z";

/** An active signal_weights row with the starting weights, no proposal and counter 0. */
export function makeWeightsRow(overrides: Partial<SignalWeights> = {}): SignalWeights {
  return {
    id: WEIGHTS_ID,
    countryMismatch: DEFAULT_SIGNAL_WEIGHTS.country_mismatch,
    firstTimeHighValue: DEFAULT_SIGNAL_WEIGHTS.first_time_high_value,
    rushShipping: DEFAULT_SIGNAL_WEIGHTS.rush_shipping,
    highRelativeValue: DEFAULT_SIGNAL_WEIGHTS.high_relative_value,
    disposableEmail: DEFAULT_SIGNAL_WEIGHTS.disposable_email,
    repeatedAttempts: DEFAULT_SIGNAL_WEIGHTS.repeated_attempts,
    isActive: true,
    resolvedSinceLastProposal: 0,
    proposedCountryMismatch: null,
    proposedFirstTimeHighValue: null,
    proposedRushShipping: null,
    proposedHighRelativeValue: null,
    proposedDisposableEmail: null,
    proposedRepeatedAttempts: null,
    proposalReasoning: null,
    proposalCreatedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

/** A row with a pending proposal for `proposed`. */
export function withProposal(proposed: SignalWeightValues, createdAt = "2026-11-07T12:00:00.000Z", reasoning = "Because."): Partial<SignalWeights> {
  return {
    proposedCountryMismatch: proposed.country_mismatch,
    proposedFirstTimeHighValue: proposed.first_time_high_value,
    proposedRushShipping: proposed.rush_shipping,
    proposedHighRelativeValue: proposed.high_relative_value,
    proposedDisposableEmail: proposed.disposable_email,
    proposedRepeatedAttempts: proposed.repeated_attempts,
    proposalReasoning: reasoning,
    proposalCreatedAt: createdAt,
  };
}

export type FakeOutcome = OutcomeForProposal & { id: string; seeded: boolean };

export function makeOutcome(n: number, overrides: Partial<FakeOutcome> = {}): FakeOutcome {
  return {
    id: `outcome-${String(n).padStart(3, "0")}`,
    outcome: "won",
    reason: "item_not_received",
    amountUsd: 100,
    riskScore: 20,
    verdict: "ship",
    winProbability: 0.9,
    activeSignals: [],
    isSimulated: false,
    createdAt: new Date(NOW.getTime() - (100 - n) * 60_000).toISOString(),
    seeded: false,
    ...overrides,
  };
}

export interface FakeInsightsRepo extends InsightsRepo {
  weights: SignalWeights;
  outcomes: FakeOutcome[];
  cache: InsightsCacheRow | null;
  /** Calls that changed something, for "nothing was stored" assertions. */
  writes: { storeProposal: number; resetCounter: number; applyProposal: number; rejectProposal: number; upsertCache: number };
}

export function createFakeInsightsRepo(init: { weights?: Partial<SignalWeights>; outcomes?: FakeOutcome[]; cache?: InsightsCacheRow | null } = {}): FakeInsightsRepo {
  const writes = { storeProposal: 0, resetCounter: 0, applyProposal: 0, rejectProposal: 0, upsertCache: 0 };
  const state = { weights: makeWeightsRow(init.weights), outcomes: init.outcomes ?? [], cache: init.cache ?? null };
  const clearProposal = (w: SignalWeights): SignalWeights => ({
    ...w,
    proposedCountryMismatch: null,
    proposedFirstTimeHighValue: null,
    proposedRushShipping: null,
    proposedHighRelativeValue: null,
    proposedDisposableEmail: null,
    proposedRepeatedAttempts: null,
    proposalReasoning: null,
    proposalCreatedAt: null,
  });

  return {
    get weights() {
      return state.weights;
    },
    get outcomes() {
      return state.outcomes;
    },
    get cache() {
      return state.cache;
    },
    writes,

    async getActiveWeights() {
      return state.weights.isActive ? state.weights : null;
    },

    async getOutcomeStats(): Promise<OutcomeStats> {
      const sorted = [...state.outcomes].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
      return {
        total: state.outcomes.length,
        won: state.outcomes.filter((o) => o.outcome === "won").length,
        lost: state.outcomes.filter((o) => o.outcome === "lost").length,
        refunded: state.outcomes.filter((o) => o.outcome === "refunded").length,
        simulated: state.outcomes.filter((o) => o.isSimulated).length,
        seeded: state.outcomes.filter((o) => o.seeded).length,
        latestOutcomeId: sorted[0]?.id ?? null,
      };
    },

    async listRecentOutcomes(limit) {
      return [...state.outcomes]
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map((o): OutcomeForProposal => ({
          outcome: o.outcome,
          reason: o.reason,
          amountUsd: o.amountUsd,
          riskScore: o.riskScore,
          verdict: o.verdict,
          winProbability: o.winProbability,
          activeSignals: o.activeSignals,
          isSimulated: o.isSimulated,
          createdAt: o.createdAt,
        }));
    },

    async storeProposal({ weightsId, proposed, reasoning, createdAt }) {
      if (state.weights.id !== weightsId || !state.weights.isActive || state.weights.proposalCreatedAt !== null) return false; // WHERE proposal_created_at IS NULL
      state.weights = { ...state.weights, ...withProposal(proposed, createdAt, reasoning), resolvedSinceLastProposal: 0 };
      writes.storeProposal += 1;
      return true;
    },

    async resetCounter(weightsId) {
      if (state.weights.id === weightsId) state.weights = { ...state.weights, resolvedSinceLastProposal: 0 };
      writes.resetCounter += 1;
    },

    async applyProposal(weightsId, proposalCreatedAt) {
      const w = state.weights;
      if (w.id !== weightsId || w.proposalCreatedAt !== proposalCreatedAt) return null;
      const values = [w.proposedCountryMismatch, w.proposedFirstTimeHighValue, w.proposedRushShipping, w.proposedHighRelativeValue, w.proposedDisposableEmail, w.proposedRepeatedAttempts];
      if (values.some((v) => v === null)) return null;
      state.weights = clearProposal({
        ...w,
        countryMismatch: w.proposedCountryMismatch!,
        firstTimeHighValue: w.proposedFirstTimeHighValue!,
        rushShipping: w.proposedRushShipping!,
        highRelativeValue: w.proposedHighRelativeValue!,
        disposableEmail: w.proposedDisposableEmail!,
        repeatedAttempts: w.proposedRepeatedAttempts!,
        resolvedSinceLastProposal: 0,
      });
      writes.applyProposal += 1;
      return state.weights;
    },

    async rejectProposal(weightsId, proposalCreatedAt) {
      const w = state.weights;
      if (w.id !== weightsId || w.proposalCreatedAt !== proposalCreatedAt) return null;
      state.weights = clearProposal(w); // the counter is left alone
      writes.rejectProposal += 1;
      return state.weights;
    },

    async getCache() {
      return state.cache;
    },

    async upsertCache(row: NewInsightsCache) {
      state.cache = { id: INSIGHTS_CACHE_ID, ...row };
      writes.upsertCache += 1;
    },
  };
}

/** LLM dependencies that count budget checks (one per model call) and record log entries. */
export function fakeLlmDeps(overrides: Partial<LlmDeps> = {}) {
  const deps = {
    isConfigured: vi.fn(() => true),
    checkBudget: vi.fn(async () => ({ allowed: true })),
    logActivity: vi.fn(async () => undefined),
    ...overrides,
  } satisfies LlmDeps;
  return deps;
}
