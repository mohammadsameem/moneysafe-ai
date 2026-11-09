/**
 * Dispute analysis (M2-02, REQ-DIS-03/04).
 *
 * Division of labour:
 *   SYSTEM  computes the evidence completeness, base win probability and the contest-vs-refund
 *           recommendation (src/lib/scoring), and owns every final number.
 *   MODEL   returns only a small adjustment (clamped here to +/-0.1), a plain-English reasoning,
 *           an optional override of the recommendation, and short evidence lists.
 *
 * Both model calls go through callWithFallback, so a missing key, a spent budget, an outage or an
 * answer that fails validation yields the system's own result with `usedFallback: true`. The model
 * has no tool that can change anything; it only returns text and numbers for the merchant to read.
 */
import type { CostAssumptions } from "@/lib/env";
import { describeEvidence, extractEvidenceFacts } from "@/lib/evidence/summary";
import { evidenceGapLabels, evidenceUsedLabels } from "@/lib/evidence/labels";
import {
  clampLlmAdjustment,
  computeBaseWinProbability,
  computeEvidenceCompleteness,
  computeSystemRecommendation,
  computeWinProbability,
  contestExpectedValue,
  resolveFinalRecommendation,
  toWinLikelihoodLabel,
  type ArtefactInput,
  type DisputeReason,
  type Recommendation,
  type RecommendationSource,
  type WinLikelihoodLabel,
} from "@/lib/scoring";
import { callWithFallback, type FallbackReason } from "./call-with-fallback";
import { buildDisputeAnalysisPrompt, buildDraftResponsePrompt, type DisputePromptInput } from "./prompts";
import { getConfiguredProviders } from "./providers";
import { ruleBasedDisputeReasoning, ruleBasedDraftResponse } from "./rule-based";
import { DisputeAnalysisSchema, DraftResponseSchema } from "./schemas";
import { callStructured } from "./structured";
import { DISPUTE_ANALYSIS_TOOL, DISPUTE_DRAFT_RESPONSE_TOOL } from "./tools";
import type { ExplainerDeps } from "./risk-explainer";

/** Each dispute AI call is bounded so a slow provider cannot hold the page open for long. */
export const DISPUTE_AI_TIMEOUT_MS = 12_000;
/** An override needs a real explanation; shorter than this and it is ignored. */
export const MIN_OVERRIDE_REASONING_CHARS = 20;

export interface DisputeSubject {
  disputeId: string;
  orderId: string;
  reason: DisputeReason;
  amountUsd: number;
  /** UNTRUSTED. Only ever placed, escaped, inside a <data> section. */
  buyerMessage: string | null;
  /** Only `artefactType` and `payload` are read, so a database row satisfies this. */
  artefacts: readonly ArtefactInput[];
}

/** The system's own numbers. Pure: no model, no database. */
export interface BaseAssessment extends CostAssumptions {
  completeness: number;
  baseWinProbability: number;
  systemRecommendation: Recommendation;
  expectedValueUsd: number;
}

export function assessDispute(subject: DisputeSubject, costs: CostAssumptions): BaseAssessment {
  const completeness = computeEvidenceCompleteness(subject.artefacts);
  const baseWinProbability = computeBaseWinProbability(completeness, subject.artefacts, subject.reason);
  return {
    ...costs,
    completeness,
    baseWinProbability,
    systemRecommendation: computeSystemRecommendation(subject.amountUsd, baseWinProbability, costs.chargebackFeeUsd, costs.contestEffortUsd),
    expectedValueUsd: contestExpectedValue(subject.amountUsd, baseWinProbability, costs.chargebackFeeUsd, costs.contestEffortUsd),
  };
}

export interface DisputeAnalysisResult {
  baseWinProbability: number;
  /** Null when the model was unavailable. */
  llmAdjustment: number | null;
  winProbability: number | null;
  winLikelihoodLabel: WinLikelihoodLabel | null;
  systemRecommendation: Recommendation;
  overrideRecommendation: Recommendation | null;
  finalRecommendation: Recommendation;
  recommendationSource: RecommendationSource;
  reasoning: string;
  evidenceUsed: string[];
  evidenceGaps: string[];
  usedFallback: boolean;
  reason?: FallbackReason;
}

export interface DisputeAiContext {
  sessionId?: string | null;
  lineItemNames?: readonly string[];
}

function promptInput(subject: DisputeSubject, completeness: number): DisputePromptInput {
  const facts = extractEvidenceFacts(subject.artefacts);
  return {
    reason: subject.reason,
    amountUsd: subject.amountUsd,
    buyerMessage: subject.buyerMessage,
    lineItemNames: facts.itemNames,
    evidenceLines: describeEvidence(subject.artefacts, completeness),
  };
}

const providersOf = (deps: ExplainerDeps) => (deps.getProviders ?? getConfiguredProviders)();

/** The result when the model is unavailable: the system recommendation, no win-likelihood figure. */
function systemOnly(subject: DisputeSubject, a: BaseAssessment, reason?: FallbackReason): DisputeAnalysisResult {
  return {
    baseWinProbability: a.baseWinProbability,
    llmAdjustment: null,
    winProbability: null,
    winLikelihoodLabel: null,
    systemRecommendation: a.systemRecommendation,
    overrideRecommendation: null,
    finalRecommendation: a.systemRecommendation,
    recommendationSource: "system",
    reasoning: ruleBasedDisputeReasoning({
      reason: subject.reason,
      amountUsd: subject.amountUsd,
      completeness: a.completeness,
      baseWinProbability: a.baseWinProbability,
      systemRecommendation: a.systemRecommendation,
      expectedValueUsd: a.expectedValueUsd,
      chargebackFeeUsd: a.chargebackFeeUsd,
      contestEffortUsd: a.contestEffortUsd,
    }),
    evidenceUsed: evidenceUsedLabels([...subject.artefacts]),
    evidenceGaps: evidenceGapLabels([...subject.artefacts]),
    usedFallback: true,
    ...(reason ? { reason } : {}),
  };
}

export async function analyseDispute(
  subject: DisputeSubject,
  assessment: BaseAssessment,
  ctx: DisputeAiContext,
  deps: ExplainerDeps,
): Promise<DisputeAnalysisResult> {
  const fallback = systemOnly(subject, assessment);
  const { result, usedFallback, reason } = await callWithFallback<DisputeAnalysisResult>(
    async (call) => {
      const { data } = await callStructured({
        providers: providersOf(deps),
        tool: DISPUTE_ANALYSIS_TOOL,
        schema: DisputeAnalysisSchema,
        prompt: buildDisputeAnalysisPrompt({
          ...promptInput(subject, assessment.completeness),
          baseWinProbability: assessment.baseWinProbability,
          systemRecommendation: assessment.systemRecommendation,
          chargebackFeeUsd: assessment.chargebackFeeUsd,
          contestEffortUsd: assessment.contestEffortUsd,
        }),
        onAttempt: call.onAttempt,
        timeoutMs: DISPUTE_AI_TIMEOUT_MS,
        fetchImpl: deps.fetchImpl,
      });

      // The system owns the numbers: clamp the adjustment, then compute everything from it.
      const llmAdjustment = clampLlmAdjustment(data.llm_adjustment);
      const winProbability = computeWinProbability(assessment.baseWinProbability, llmAdjustment);
      // An override with no real explanation is ignored: the merchant must be told why.
      const override = data.reasoning.length >= MIN_OVERRIDE_REASONING_CHARS ? data.override_recommendation : null;
      const final = resolveFinalRecommendation(assessment.systemRecommendation, override);

      return {
        baseWinProbability: assessment.baseWinProbability,
        llmAdjustment,
        winProbability,
        winLikelihoodLabel: toWinLikelihoodLabel(winProbability),
        systemRecommendation: assessment.systemRecommendation,
        overrideRecommendation: final.override,
        finalRecommendation: final.recommendation,
        recommendationSource: final.source,
        reasoning: data.reasoning,
        evidenceUsed: data.evidence_used,
        evidenceGaps: data.evidence_gaps,
        usedFallback: false,
      };
    },
    fallback,
    {
      sessionId: ctx.sessionId ?? undefined,
      toolName: DISPUTE_ANALYSIS_TOOL.name,
      inputSummary: `${subject.reason}; base ${Math.round(assessment.baseWinProbability * 100)}%; system recommends ${assessment.systemRecommendation}`,
      refDisputeId: subject.disputeId,
    },
    deps.llm,
  );
  return usedFallback ? systemOnly(subject, assessment, reason) : result;
}

export interface DraftResult {
  text: string;
  usedFallback: boolean;
  reason?: FallbackReason;
}

/** The rule-based draft, from the facts on file. */
export function fallbackDraft(subject: DisputeSubject): string {
  const facts = extractEvidenceFacts(subject.artefacts);
  const last = facts.scans[facts.scans.length - 1];
  return ruleBasedDraftResponse({
    reason: subject.reason,
    amountUsd: subject.amountUsd,
    itemName: facts.itemNames[0] ?? null,
    carrier: facts.carrier,
    trackingNumber: facts.trackingNumber,
    shippedOn: facts.shippedAt ? facts.shippedAt.slice(0, 10) : null,
    lastScan: last ? { status: last.status, date: last.timestamp.slice(0, 10) } : null,
    deliveredOn: facts.deliveredAt ? facts.deliveredAt.slice(0, 10) : null,
  });
}

export async function draftDisputeResponse(
  subject: DisputeSubject,
  completeness: number,
  ctx: DisputeAiContext,
  deps: ExplainerDeps,
): Promise<DraftResult> {
  const { result, usedFallback, reason } = await callWithFallback<string>(
    (call) =>
      callStructured({
        providers: providersOf(deps),
        tool: DISPUTE_DRAFT_RESPONSE_TOOL,
        schema: DraftResponseSchema,
        prompt: buildDraftResponsePrompt(promptInput(subject, completeness)),
        onAttempt: call.onAttempt,
        timeoutMs: DISPUTE_AI_TIMEOUT_MS,
        fetchImpl: deps.fetchImpl,
      }).then((r) => r.data.response_text),
    fallbackDraft(subject),
    {
      sessionId: ctx.sessionId ?? undefined,
      toolName: DISPUTE_DRAFT_RESPONSE_TOOL.name,
      inputSummary: `${subject.reason}; draft a response citing the evidence on file`,
      refDisputeId: subject.disputeId,
    },
    deps.llm,
  );
  return { text: result, usedFallback, ...(reason ? { reason } : {}) };
}
