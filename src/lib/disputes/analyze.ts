/**
 * POST /api/disputes/[id]/analyze (M2-03, design 7.3, REQ-NFR-14).
 *
 *   - Cached: a dispute with `analysis_computed_at` set returns its stored analysis and makes NO
 *     model call. Every seeded dispute is analysed at seed time, so seeds always hit this path.
 *   - Otherwise: evidence -> completeness -> base win probability -> system recommendation (pure),
 *     then the model adjusts and explains (falls back to the system result), then, for a final
 *     "contest", the model drafts a response (falls back to a factual template).
 *   - Saved once: only the first writer wins, so a double-click cannot overwrite an analysis.
 */
import type { ActivityMeta } from "@/lib/activity/logger";
import { analyseDispute, assessDispute, draftDisputeResponse, type DisputeSubject } from "@/lib/ai/dispute-analyst";
import type { ExplainerDeps } from "@/lib/ai/risk-explainer";
import type { CostAssumptions } from "@/lib/env";
import { toDisputeView, type DisputeView } from "./read";
import type { AnalysisPatch, DisputeRecord, DisputesAnalysisRepo } from "./types";

export interface AnalyzeDeps {
  repo: DisputesAnalysisRepo;
  explainer: ExplainerDeps;
  costs: CostAssumptions;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
}

export type AnalyzeOutcome =
  | { kind: "cached"; view: DisputeView }
  | { kind: "analyzed"; view: DisputeView; usedFallback: boolean }
  | { kind: "not_found" };

export async function analyzeDispute(disputeId: string, sessionId: string, deps: AnalyzeDeps): Promise<AnalyzeOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const record = await deps.repo.findVisible(disputeId, sessionId);
  if (!record) return { kind: "not_found" };

  // Guard: never analyse twice, and never call a model for an analysed (for example seeded) dispute.
  if (record.dispute.analysisComputedAt !== null) return { kind: "cached", view: toDisputeView(record, now) };

  const { dispute, order } = record;
  const log = async (step: Omit<ActivityMeta, "sessionId" | "refDisputeId" | "durationMs">, startedAt: number) => {
    try {
      await deps.log?.({ sessionId, refDisputeId: dispute.id, durationMs: Date.now() - startedAt, ...step });
    } catch {
      /* logging is best effort */
    }
  };

  const artefacts = await deps.repo.getArtefacts(order.id);
  const subject: DisputeSubject = {
    disputeId: dispute.id,
    orderId: order.id,
    reason: dispute.reason,
    amountUsd: dispute.disputedAmountUsd,
    buyerMessage: dispute.buyerMessage,
    artefacts,
  };

  // 1. The system's own numbers (pure).
  const ruleStarted = Date.now();
  const assessment = assessDispute(subject, deps.costs);
  await log(
    {
      stepType: "rule_engine",
      toolName: "assess_dispute",
      inputSummary: `${dispute.reason}; ${artefacts.length} evidence artefacts; amount ${dispute.disputedAmountUsd.toFixed(2)} USD`,
      outputSummary: `completeness ${assessment.completeness}%; base ${Math.round(assessment.baseWinProbability * 100)}%; EV ${assessment.expectedValueUsd.toFixed(2)} USD; system recommends ${assessment.systemRecommendation}`,
      status: "success",
    },
    ruleStarted,
  );

  // 2. The model adjusts and explains (or the system result stands).
  const ctx = { sessionId };
  const analysis = await analyseDispute(subject, assessment, ctx, deps.explainer);

  // 3. A draft response only when the final recommendation is to contest.
  let draftResponse: string | null = null;
  if (analysis.finalRecommendation === "contest") {
    const draft = await draftDisputeResponse(subject, assessment.completeness, ctx, deps.explainer);
    draftResponse = draft.text; // the model's draft, or the factual template if the model was unavailable
  }

  const patch: AnalysisPatch = {
    baseWinProbability: roundTo(analysis.baseWinProbability, 4),
    llmAdjustment: analysis.llmAdjustment,
    winProbability: analysis.winProbability === null ? null : roundTo(analysis.winProbability, 4),
    winLikelihoodLabel: analysis.winLikelihoodLabel,
    systemRecommendation: analysis.systemRecommendation,
    overrideRecommendation: analysis.overrideRecommendation,
    finalRecommendation: analysis.finalRecommendation,
    recommendationSource: analysis.recommendationSource,
    reasoning: analysis.reasoning,
    evidenceUsed: analysis.evidenceUsed,
    evidenceGaps: analysis.evidenceGaps,
    draftResponse,
    analysisComputedAt: now.toISOString(),
    riskScoreSnapshot: order.riskScore,
  };

  const saveStarted = Date.now();
  const saved = await deps.repo.saveAnalysis(dispute.id, patch);
  if (!saved) {
    // Another request finished first. Show its result; ours is discarded.
    const current: DisputeRecord | null = await deps.repo.findVisible(dispute.id, sessionId);
    return current ? { kind: "cached", view: toDisputeView(current, now) } : { kind: "not_found" };
  }

  await log(
    {
      stepType: "rule_engine",
      toolName: "save_analysis",
      inputSummary: `final recommendation ${analysis.finalRecommendation} (${analysis.recommendationSource})`,
      outputSummary: analysis.usedFallback
        ? `saved the system recommendation without AI (${analysis.reason ?? "fallback"})${draftResponse ? "; draft saved" : ""}`
        : `saved; win likelihood ${Math.round((analysis.winProbability ?? 0) * 100)}% ${analysis.winLikelihoodLabel ?? ""}${draftResponse ? "; draft saved" : ""}`,
      status: analysis.usedFallback ? "fallback" : "success",
    },
    saveStarted,
  );

  const record2: DisputeRecord = { dispute: saved, order };
  return { kind: "analyzed", view: toDisputeView(record2, now), usedFallback: analysis.usedFallback };
}

function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
