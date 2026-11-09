/**
 * The two AI steps of the order flow: a plain-English risk explanation and, for "Verify first"
 * orders, a buyer verification message.
 *
 * Both go through callWithFallback, so they never throw because of the model and never return
 * nothing: with no key, a spent budget, a provider outage or an answer that fails validation, the
 * caller gets the deterministic rule-based text and `usedFallback: true`. Every provider attempt
 * is logged to agent_activity by callWithFallback.
 *
 * The model only ever writes text for the merchant to read (and, for the draft, to review before
 * anything is sent). Its output cannot trigger an action.
 */
import type { Order, VerificationDraft } from "@/db/schema";
import { callWithFallback, type FallbackReason, type LlmDeps } from "./call-with-fallback";
import { buildRiskPrompt, buildVerificationPrompt, type PromptOrder, type PromptSignal } from "./prompts";
import { getConfiguredProviders, type LlmProvider } from "./providers";
import { ruleBasedExplanation, staticVerificationDraft } from "./rule-based";
import { RiskExplanationSchema, VerificationDraftSchema } from "./schemas";
import { callStructured } from "./structured";
import { RISK_EXPLANATION_TOOL, VERIFICATION_DRAFT_TOOL } from "./tools";

/** Each order AI call is bounded so a slow provider cannot hold up the buyer's redirect. */
export const ORDER_AI_TIMEOUT_MS = 12_000;

export interface ExplainerDeps {
  /** isConfigured / checkBudget / logActivity, bound by the caller. */
  llm: LlmDeps;
  /** Defaults to the providers from the LLM_* environment variables. */
  getProviders?: () => readonly LlmProvider[];
  fetchImpl?: typeof fetch;
}

export interface ExplainerContext {
  sessionId?: string | null;
  /** Product names, if known (from the line_items evidence). Escaped and capped by the prompt builder. */
  lineItemNames?: readonly string[];
}

export interface AiOutcome<T> {
  value: T;
  usedFallback: boolean;
  reason?: FallbackReason;
}

/** Pull the scored fields out of an order, or fail loudly: calling the AI before scoring is a bug. */
function scoredParts(order: Order): { prompt: PromptOrder; signals: PromptSignal[] } {
  if (order.riskScore === null || order.verdict === null || order.signalBreakdown === null) {
    throw new Error("the order must be scored before it is explained");
  }
  return {
    prompt: {
      amountUsd: order.amountUsd,
      currency: order.currency,
      shippingMethod: order.shippingMethod,
      billingCountry: order.billingCountry,
      shippingCountry: order.shippingCountry,
      buyerIsFirstTime: order.buyerIsFirstTime,
      paymentAttemptCount: order.paymentAttemptCount,
      riskScore: order.riskScore,
      verdict: order.verdict,
    },
    signals: order.signalBreakdown,
  };
}

/** A PII-free line for agent_activity: ids and signal names only. */
function summaryOf(prompt: PromptOrder, signals: readonly PromptSignal[]): string {
  const active = signals.filter((s) => s.active).map((s) => s.signal);
  return `score ${prompt.riskScore} -> ${prompt.verdict}; active signals: ${active.length > 0 ? active.join(", ") : "none"}`;
}

export async function explainRisk(order: Order, ctx: ExplainerContext, deps: ExplainerDeps): Promise<AiOutcome<string>> {
  const { prompt, signals } = scoredParts(order);
  const { result, usedFallback, reason } = await callWithFallback<string>(
    (call) =>
      callStructured({
        providers: (deps.getProviders ?? getConfiguredProviders)(),
        tool: RISK_EXPLANATION_TOOL,
        schema: RiskExplanationSchema,
        prompt: buildRiskPrompt(prompt, signals, ctx.lineItemNames),
        onAttempt: call.onAttempt,
        timeoutMs: ORDER_AI_TIMEOUT_MS,
        fetchImpl: deps.fetchImpl,
      }).then((r) => r.data.explanation),
    ruleBasedExplanation(prompt, signals),
    { sessionId: ctx.sessionId ?? undefined, toolName: RISK_EXPLANATION_TOOL.name, inputSummary: summaryOf(prompt, signals), refOrderId: order.id },
    deps.llm,
  );
  return { value: result, usedFallback, ...(reason ? { reason } : {}) };
}

export async function draftVerification(
  order: Order,
  ctx: ExplainerContext,
  deps: ExplainerDeps,
): Promise<AiOutcome<VerificationDraft>> {
  const { prompt, signals } = scoredParts(order);
  const { result, usedFallback, reason } = await callWithFallback<VerificationDraft>(
    (call) =>
      callStructured({
        providers: (deps.getProviders ?? getConfiguredProviders)(),
        tool: VERIFICATION_DRAFT_TOOL,
        schema: VerificationDraftSchema,
        prompt: buildVerificationPrompt(prompt, signals, ctx.lineItemNames),
        onAttempt: call.onAttempt,
        timeoutMs: ORDER_AI_TIMEOUT_MS,
        fetchImpl: deps.fetchImpl,
      }).then((r) => ({ subject: r.data.subject, body: r.data.body })),
    staticVerificationDraft(signals),
    { sessionId: ctx.sessionId ?? undefined, toolName: VERIFICATION_DRAFT_TOOL.name, inputSummary: summaryOf(prompt, signals), refOrderId: order.id },
    deps.llm,
  );
  return { value: result, usedFallback, ...(reason ? { reason } : {}) };
}
