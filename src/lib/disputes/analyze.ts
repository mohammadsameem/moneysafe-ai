/**
 * POST /api/disputes/[id]/analyze (M2-03, design 7.3, REQ-NFR-14).
 *
 *   - Cached: a dispute that already has an analysis returns it with NO model call. Every seeded
 *     dispute is analysed at seed time, so seeds always take this path.
 *   - In flight (fix 3): before any model call a request CLAIMS the dispute atomically (see
 *     analysis-state.ts). Only the claim winner spends model budget; a simultaneous request waits
 *     and returns the winner's saved result, so two clicks cost one analysis, not two.
 *   - Otherwise: evidence -> completeness -> base win probability -> system recommendation (pure),
 *     then the model adjusts and explains (falls back to the system result), then, for a final
 *     "contest", the model drafts a response (falls back to a factual template).
 */
import { randomUUID } from "node:crypto";
import type { ActivityMeta } from "@/lib/activity/logger";
import { analyseDispute, assessDispute, draftDisputeResponse, type DisputeSubject } from "@/lib/ai/dispute-analyst";
import type { ExplainerDeps } from "@/lib/ai/risk-explainer";
import type { CostAssumptions } from "@/lib/env";
import { CLAIM_STALE_MS, isAnalysed, newClaimToken } from "./analysis-state";
import { toDisputeView, type DisputeView } from "./read";
import type { AnalysisPatch, DisputeRecord, DisputesAnalysisRepo } from "./types";

/** How long a request that lost the claim waits for the winner before answering "in progress". */
export const WAIT_FOR_WINNER_MS = 45_000;
export const WAIT_POLL_MS = 750;

export interface AnalyzeDeps {
  repo: DisputesAnalysisRepo;
  explainer: ExplainerDeps;
  costs: CostAssumptions;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  waitForWinnerMs?: number;
  pollMs?: number;
  newClaimId?: () => string;
}

export type AnalyzeOutcome =
  | { kind: "cached"; view: DisputeView }
  | { kind: "analyzed"; view: DisputeView; usedFallback: boolean }
  /** Another request is still analysing this dispute and did not finish within the wait. Ask again shortly. */
  | { kind: "in_progress" }
  | { kind: "not_found" };

export async function analyzeDispute(disputeId: string, sessionId: string, deps: AnalyzeDeps): Promise<AnalyzeOutcome> {
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.waitForWinnerMs ?? WAIT_FOR_WINNER_MS;
  const pollMs = deps.pollMs ?? WAIT_POLL_MS;
  const startedWaiting = clock().getTime();

  for (;;) {
    const record = await deps.repo.findVisible(disputeId, sessionId);
    if (!record) return { kind: "not_found" };

    // Guard 1: never analyse twice, and never call a model for an analysed (for example seeded) dispute.
    if (isAnalysed(record.dispute.analysisComputedAt)) return { kind: "cached", view: toDisputeView(record, clock()) };

    // Guard 2: only the request that wins the atomic claim may spend model budget.
    const now = clock();
    const token = newClaimToken(now, (deps.newClaimId ?? randomUUID)());
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
    if (await deps.repo.claimAnalysis(record.dispute.id, token, staleBefore)) {
      return runClaimedAnalysis(record, token, sessionId, deps, now);
    }

    // Someone else is analysing it (or just finished). Wait for their result; if they fail and
    // release the claim, the next loop iteration claims it ourselves.
    if (clock().getTime() - startedWaiting >= waitMs) return { kind: "in_progress" };
    await sleep(pollMs);
  }
}

async function runClaimedAnalysis(
  record: DisputeRecord,
  token: string,
  sessionId: string,
  deps: AnalyzeDeps,
  now: Date,
): Promise<AnalyzeOutcome> {
  const { dispute, order } = record;
  const log = async (step: Omit<ActivityMeta, "sessionId" | "refDisputeId" | "durationMs">, startedAt: number) => {
    try {
      await deps.log?.({ sessionId, refDisputeId: dispute.id, durationMs: Date.now() - startedAt, ...step });
    } catch {
      /* logging is best effort */
    }
  };

  try {
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
    const saved = await deps.repo.saveAnalysis(dispute.id, patch, token);
    if (!saved) {
      // Our claim was taken over as stale while we worked (we were far too slow). Show whatever is stored now.
      const current = await deps.repo.findVisible(dispute.id, sessionId);
      return current && isAnalysed(current.dispute.analysisComputedAt) ? { kind: "cached", view: toDisputeView(current, now) } : { kind: "in_progress" };
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

    return { kind: "analyzed", view: toDisputeView({ dispute: saved, order }, now), usedFallback: analysis.usedFallback };
  } catch (err) {
    // Give the claim back so the next request can try, instead of leaving it to go stale.
    try {
      await deps.repo.releaseAnalysisClaim(dispute.id, token);
    } catch {
      /* it will go stale and be taken over */
    }
    throw err;
  }
}

function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
