/**
 * The Insights read model (M4-02). Read-only and model-free by construction: it takes a repo and
 * nothing else, so it cannot reach a model. The summary comes from the cache; if the cache is
 * missing or out of date, a deterministic rule-based summary of the CURRENT data is shown instead,
 * with the "AI unavailable" note. (A test asserts this module imports nothing from the AI layer.)
 */
import { AI_UNAVAILABLE_NOTE, signalLabel } from "@/lib/format";
import { toSignalWeightValues } from "@/lib/orders/weights";
import { SIGNAL_NAMES, type SignalName } from "@/lib/scoring";
import { SEED_PROPOSAL_REASONING } from "@/seed/data";
import { currentFingerprint } from "./fingerprint";
import { ruleBasedInsightsSummary } from "./summary-text";
import type { InsightsRepo, InsightsSummaryInput } from "./types";
import { BASELINE_WEIGHTS, PROPOSAL_EVERY, proposedWeights } from "./weights";

export interface WeightView {
  signal: SignalName;
  label: string;
  current: number;
  baseline: number;
  /** current - baseline */
  delta: number;
}

export interface ProposalChangeView {
  signal: SignalName;
  label: string;
  current: number;
  proposed: number;
  /** proposed - current */
  delta: number;
}

export interface ProposalView {
  /** The id of this proposal: approve / reject must send it back, so you can only decide what you saw. */
  createdAt: string;
  reasoning: string;
  /** All six signals, changed or not. */
  changes: ProposalChangeView[];
  /** True for the seeded proposal (shows the Demo data badge). */
  isDemo: boolean;
}

export interface SummaryView {
  text: string;
  /** True when a rule-based text stands in for an AI one (the "AI unavailable" note is shown). */
  usedFallback: boolean;
  note: string | null;
  generatedAt: string | null;
  source: "cached" | "rule_based";
}

export interface InsightsView {
  weights: WeightView[];
  proposal: ProposalView | null;
  outcomes: { total: number; won: number; lost: number; refunded: number; simulated: number; seeded: number; includesDemoData: boolean };
  progress: { resolved: number; every: number; remaining: number; proposalPending: boolean };
  summary: SummaryView;
}

/** Shown when the cached summary no longer matches the data (for example after "Restart my demo" removed outcomes). */
export const STALE_SUMMARY_NOTE = "Showing a rule-based summary of the current data. The written summary is refreshed after the next resolved dispute.";

export async function loadInsights(repo: InsightsRepo): Promise<InsightsView | null> {
  const row = await repo.getActiveWeights();
  if (!row) return null;
  const [stats, cache] = await Promise.all([repo.getOutcomeStats(), repo.getCache()]);
  const current = toSignalWeightValues(row);
  const proposed = proposedWeights(row);

  const weights: WeightView[] = SIGNAL_NAMES.map((signal) => ({
    signal,
    label: signalLabel(signal),
    current: current[signal],
    baseline: BASELINE_WEIGHTS[signal],
    delta: current[signal] - BASELINE_WEIGHTS[signal],
  }));

  const proposal: ProposalView | null =
    proposed && row.proposalCreatedAt
      ? {
          createdAt: row.proposalCreatedAt,
          reasoning: row.proposalReasoning ?? "",
          changes: SIGNAL_NAMES.map((signal) => ({ signal, label: signalLabel(signal), current: current[signal], proposed: proposed[signal], delta: proposed[signal] - current[signal] })),
          isDemo: row.proposalReasoning === SEED_PROPOSAL_REASONING,
        }
      : null;

  // A cached summary is only shown while it still describes the current data.
  const hasText = cache !== null && cache.summary !== null && cache.summary !== "";
  const fresh = hasText && cache.inputFingerprint === currentFingerprint(stats, row);
  let summary: SummaryView;
  if (fresh && cache) {
    summary = {
      text: cache.summary!,
      usedFallback: cache.usedFallback,
      note: cache.usedFallback ? AI_UNAVAILABLE_NOTE : null,
      generatedAt: cache.generatedAt,
      source: "cached",
    };
  } else {
    const input: InsightsSummaryInput = { stats, current, proposed, counter: row.resolvedSinceLastProposal, recent: [] };
    // Missing: nothing was ever written, so AI text is unavailable. Out of date (an outcome was removed
    // by a session restart, or a refresh failed): the data moved on and the next change rewrites it.
    summary = {
      text: ruleBasedInsightsSummary(input),
      usedFallback: true,
      note: hasText ? STALE_SUMMARY_NOTE : AI_UNAVAILABLE_NOTE,
      generatedAt: null,
      source: "rule_based",
    };
  }

  return {
    weights,
    proposal,
    outcomes: {
      total: stats.total,
      won: stats.won,
      lost: stats.lost,
      refunded: stats.refunded,
      simulated: stats.simulated,
      seeded: stats.seeded,
      includesDemoData: stats.seeded > 0,
    },
    progress: { resolved: row.resolvedSinceLastProposal, every: PROPOSAL_EVERY, remaining: PROPOSAL_EVERY - (row.resolvedSinceLastProposal % PROPOSAL_EVERY), proposalPending: proposal !== null },
    summary,
  };
}
