/**
 * callWithFallback (design 5.6): every LLM call site goes through this.
 *
 *   not configured -> rule-based result, no budget used, no network call
 *   budget exceeded -> rule-based result (per-session or global daily cap), no network call
 *   LLM call throws -> rule-based result
 *   otherwise      -> the model's validated result
 *
 * It never throws because of the LLM, and it never returns HTTP 429: the UI shows the visible
 * "AI unavailable - showing rule-based result" note whenever `usedFallback` is true.
 *
 * The activity logger and the budget check are injected. They are implemented by M1-08 (agent
 * activity logger) and M1-09b (checkLlmBudget); this module only depends on their shape.
 */
import { LlmNotConfiguredError, LlmUnavailableError, LlmValidationError } from "./errors";
import type { LlmAttempt } from "./structured";

export type FallbackReason =
  | "not_configured"
  | "budget_session"
  | "budget_daily"
  | "providers_unavailable"
  | "validation_failed"
  | "unexpected_error";

export interface CallMeta {
  sessionId?: string;
  /** Tool/feature name, e.g. "risk_explanation". */
  toolName: string;
  /** PII-scrubbed summary of what is being asked. Must not contain keys. */
  inputSummary: string;
  refOrderId?: string;
  refDisputeId?: string;
}

/** The shape of a row in agent_activity for an LLM step. */
export interface LlmActivityEntry {
  sessionId?: string;
  refOrderId?: string;
  refDisputeId?: string;
  stepType: "llm_call";
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  durationMs: number;
  status: "success" | "error" | "fallback";
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: "session" | "daily";
}

export interface LlmDeps {
  /** True when at least one provider is configured. */
  isConfigured(): boolean;
  /** Per-session + global daily check. Increments the counters when it allows the call. */
  checkBudget(sessionId?: string): Promise<BudgetDecision>;
  logActivity(entry: LlmActivityEntry): Promise<void>;
}

/** Handed to the LLM closure so each provider attempt is logged with its provider name. */
export interface LlmCallContext {
  onAttempt: (attempt: LlmAttempt) => Promise<void>;
}

export interface CallResult<T> {
  result: T;
  usedFallback: boolean;
  /** Set when usedFallback is true. */
  reason?: FallbackReason;
}

export async function callWithFallback<T>(
  llmCall: (ctx: LlmCallContext) => Promise<T>,
  fallback: T,
  meta: CallMeta,
  deps: LlmDeps,
): Promise<CallResult<T>> {
  const started = Date.now();

  // Logging is best effort: a failed log write must not change the outcome.
  const log = async (entry: Omit<LlmActivityEntry, "stepType" | "toolName" | "sessionId" | "refOrderId" | "refDisputeId"> & { toolName?: string }) => {
    try {
      await deps.logActivity({
        sessionId: meta.sessionId,
        refOrderId: meta.refOrderId,
        refDisputeId: meta.refDisputeId,
        stepType: "llm_call",
        toolName: meta.toolName,
        ...entry,
      });
    } catch {
      /* ignore */
    }
  };

  const respondWithFallback = async (
    reason: FallbackReason,
    outputSummary: string,
    extra: { toolName?: string; inputSummary?: string } = {},
  ): Promise<CallResult<T>> => {
    await log({
      toolName: extra.toolName,
      inputSummary: extra.inputSummary ?? meta.inputSummary,
      outputSummary,
      durationMs: Date.now() - started,
      status: "fallback",
    });
    return { result: fallback, usedFallback: true, reason };
  };

  if (!deps.isConfigured()) {
    return respondWithFallback("not_configured", "LLM not configured (LLM_API_KEY is empty); used the rule-based result");
  }

  const budget = await deps.checkBudget(meta.sessionId);
  if (!budget.allowed) {
    const limit = budget.reason ?? "daily";
    return respondWithFallback(
      limit === "session" ? "budget_session" : "budget_daily",
      "LLM budget reached; used the rule-based result",
      { toolName: "llm_budget_exceeded", inputSummary: `limit=${limit}` },
    );
  }

  try {
    const result = await llmCall({
      // One agent_activity row per provider attempt, named by provider (never by key).
      onAttempt: (a) =>
        log({
          inputSummary: `${meta.inputSummary} | provider=${a.provider} (${a.role}) model=${a.model} mode=${a.mode}`,
          outputSummary: a.detail,
          durationMs: a.durationMs,
          status: a.outcome,
        }),
    });
    return { result, usedFallback: false };
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return respondWithFallback("not_configured", "LLM not configured; used the rule-based result");
    }
    if (err instanceof LlmUnavailableError) {
      return respondWithFallback("providers_unavailable", `${err.message}; used the rule-based result`);
    }
    if (err instanceof LlmValidationError) {
      return respondWithFallback("validation_failed", `${err.message}; used the rule-based result`);
    }
    return respondWithFallback("unexpected_error", "unexpected LLM error; used the rule-based result");
  }
}
