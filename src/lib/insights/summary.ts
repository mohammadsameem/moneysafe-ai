/**
 * The cached Insights summary (M4-02, REQ-LL-03, design 7.4).
 *
 * `GET /api/insights` NEVER calls a model: it reads this cache. The cache is refreshed only by
 * write paths, through regenerateInsightsSummaryIfStale:
 *   an outcome was recorded, a proposal was created, weights were approved or rejected, demo reset.
 *
 * Staleness is a fingerprint: sha256(outcome count + latest outcome id + proposal_created_at +
 * active weights). Same fingerprint -> no model call at all.
 */
import { generateInsightsSummary } from "@/lib/ai/insights";
import type { ExplainerDeps } from "@/lib/ai/risk-explainer";
import { toSignalWeightValues } from "@/lib/orders/weights";
import { currentFingerprint } from "./fingerprint";
import type { InsightsRepo, InsightsSummaryInput } from "./types";
import { proposedWeights } from "./weights";

/** How many recent outcomes the summary prompt may mention. */
const RECENT_FOR_SUMMARY = 10;

export interface SummaryDeps {
  repo: InsightsRepo;
  ai: ExplainerDeps;
  now?: () => Date;
}

export type RegenerateResult =
  /** The cache already matches the current data: nothing was asked, nothing was written. */
  | { kind: "fresh" }
  | { kind: "regenerated"; usedFallback: boolean }
  /** There is no active weights row (an unseeded database): nothing to summarise. */
  | { kind: "no_weights" };

export async function regenerateInsightsSummaryIfStale(sessionId: string | null, deps: SummaryDeps): Promise<RegenerateResult> {
  const row = await deps.repo.getActiveWeights();
  if (!row) return { kind: "no_weights" };
  const stats = await deps.repo.getOutcomeStats();
  const fingerprint = currentFingerprint(stats, row);

  const cache = await deps.repo.getCache();
  if (cache && cache.inputFingerprint === fingerprint) return { kind: "fresh" };

  const input: InsightsSummaryInput = {
    stats,
    current: toSignalWeightValues(row),
    proposed: proposedWeights(row),
    counter: row.resolvedSinceLastProposal,
    recent: await deps.repo.listRecentOutcomes(RECENT_FOR_SUMMARY),
  };
  const result = await generateInsightsSummary(input, { sessionId }, deps.ai);
  await deps.repo.upsertCache({
    summary: result.text,
    usedFallback: result.usedFallback,
    inputFingerprint: fingerprint,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  return { kind: "regenerated", usedFallback: result.usedFallback };
}
