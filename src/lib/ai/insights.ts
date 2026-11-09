/**
 * The two AI steps of the learning loop (M4-01, REQ-LL-02 / REQ-LL-03).
 *
 *   proposeWeightChanges   the model proposes new signal weights; the SYSTEM caps every change to
 *                          +/-3 and keeps each weight in [5, 30] (src/lib/insights/weights).
 *   generateInsightsSummary a short plain-English summary of the outcomes and the pending change.
 *
 * Both go through callWithFallback, so they never throw because of the model. Unavailable means:
 * weights unchanged with a note (proposal), or the rule-based summary. The model only returns
 * numbers and text; a proposal is merely STORED as pending, and nothing is applied until the
 * merchant approves it.
 */
import { capProposal } from "@/lib/insights/weights";
import { ruleBasedInsightsSummary } from "@/lib/insights/summary-text";
import type { InsightsSummaryInput, OutcomeForProposal } from "@/lib/insights/types";
import type { SignalWeightValues } from "@/lib/scoring";
import { callWithFallback, type FallbackReason } from "./call-with-fallback";
import { buildInsightsSummaryPrompt, buildWeightProposalPrompt } from "./prompts";
import { getConfiguredProviders } from "./providers";
import { InsightsSummarySchema, WeightProposalSchema } from "./schemas";
import { callStructured } from "./structured";
import { INSIGHTS_SUMMARY_TOOL, WEIGHT_PROPOSAL_TOOL } from "./tools";
import type { ExplainerDeps } from "./risk-explainer";

/**
 * Time ONE provider gets for a learning-loop call. These run after a merchant action (Approve,
 * Simulate outcome), so they get a tighter allowance than the 8 s an analysis gets; the worst
 * case of a route that makes two of them is then 2 providers x 5 s x 2 calls = 20 s.
 */
export const INSIGHTS_LLM_TIMEOUT_MS = 5_000;

export interface InsightsAiContext {
  sessionId?: string | null;
}

export interface WeightProposalResult {
  /** The weights AFTER the system's caps. Equal to the current weights when the model was unavailable. */
  weights: SignalWeightValues;
  reasoning: string;
  /** True when the model asked for something outside the +/-3 / [5, 30] rules and the system limited it. */
  capped: boolean;
  usedFallback: boolean;
  reason?: FallbackReason;
}

export const CAPPED_NOTE = " (The system limited the change to at most 3 points per weight, within 5 to 30.)";
export const UNAVAILABLE_NOTE = "AI unavailable: no weight change was proposed, so the weights are unchanged.";

const providersOf = (deps: ExplainerDeps) => (deps.getProviders ?? getConfiguredProviders)();

export async function proposeWeightChanges(
  outcomes: readonly OutcomeForProposal[],
  current: SignalWeightValues,
  ctx: InsightsAiContext,
  deps: ExplainerDeps,
): Promise<WeightProposalResult> {
  const unchanged: WeightProposalResult = { weights: { ...current }, reasoning: UNAVAILABLE_NOTE, capped: false, usedFallback: true };
  const { result, usedFallback, reason } = await callWithFallback<WeightProposalResult>(
    async (call) => {
      const { data } = await callStructured({
        providers: providersOf(deps),
        tool: WEIGHT_PROPOSAL_TOOL,
        schema: WeightProposalSchema,
        prompt: buildWeightProposalPrompt({ current, outcomes }),
        onAttempt: call.onAttempt,
        fetchImpl: deps.fetchImpl,
        timeoutMs: INSIGHTS_LLM_TIMEOUT_MS,
      });
      // The system owns the numbers: cap every change, then keep every weight in range.
      const capped = capProposal(current, data.proposed_weights);
      return {
        weights: capped.weights,
        reasoning: capped.capped ? `${data.reasoning}${CAPPED_NOTE}` : data.reasoning,
        capped: capped.capped,
        usedFallback: false,
      };
    },
    unchanged,
    {
      sessionId: ctx.sessionId ?? undefined,
      toolName: WEIGHT_PROPOSAL_TOOL.name,
      inputSummary: `propose weights from the last ${outcomes.length} resolved disputes`,
    },
    deps.llm,
  );
  return usedFallback ? { ...unchanged, ...(reason ? { reason } : {}) } : result;
}

export interface InsightsSummaryResult {
  text: string;
  usedFallback: boolean;
  reason?: FallbackReason;
}

export async function generateInsightsSummary(input: InsightsSummaryInput, ctx: InsightsAiContext, deps: ExplainerDeps): Promise<InsightsSummaryResult> {
  const { result, usedFallback, reason } = await callWithFallback<string>(
    (call) =>
      callStructured({
        providers: providersOf(deps),
        tool: INSIGHTS_SUMMARY_TOOL,
        schema: InsightsSummarySchema,
        prompt: buildInsightsSummaryPrompt(input),
        onAttempt: call.onAttempt,
        fetchImpl: deps.fetchImpl,
        timeoutMs: INSIGHTS_LLM_TIMEOUT_MS,
      }).then((r) => r.data.summary),
    ruleBasedInsightsSummary(input),
    {
      sessionId: ctx.sessionId ?? undefined,
      toolName: INSIGHTS_SUMMARY_TOOL.name,
      inputSummary: `summarise ${input.stats.total} resolved disputes${input.proposed ? " and the pending weight change" : ""}`,
    },
    deps.llm,
  );
  return { text: result, usedFallback, ...(reason ? { reason } : {}) };
}
