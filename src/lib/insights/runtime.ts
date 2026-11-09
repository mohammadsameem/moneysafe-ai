/** Binds the learning loop to the real database, LLM layer and activity log. */
import { logActivity } from "@/lib/activity/logger";
import { getLlmDeps } from "@/lib/ai/runtime";
import type { DecideDeps } from "./decide";
import { runLearningLoop, type LoopDeps, type OutcomeEvent } from "./loop";
import { createDrizzleInsightsRepo } from "./repo";
import { regenerateInsightsSummaryIfStale, type SummaryDeps } from "./summary";

export function buildLoopDeps(): LoopDeps {
  return { repo: createDrizzleInsightsRepo(), ai: { llm: getLlmDeps() }, log: logActivity };
}

export function buildSummaryDeps(): SummaryDeps {
  return { repo: createDrizzleInsightsRepo(), ai: { llm: getLlmDeps() } };
}

export function buildDecideDeps(): DecideDeps {
  return { repo: createDrizzleInsightsRepo(), log: logActivity };
}

/**
 * Refresh the cached summary after a write path changed what it describes. Never throws: a stale
 * or failed refresh only means the Insights page shows its rule-based summary until the next one.
 */
export async function refreshInsightsSummary(sessionId: string | null): Promise<void> {
  try {
    await regenerateInsightsSummaryIfStale(sessionId, buildSummaryDeps());
  } catch {
    console.warn("[insights] the summary refresh failed; the Insights page shows a rule-based summary until the next change");
  }
}

/**
 * The hook the dispute services call after an outcome was recorded (refund, Won, Lost): first the
 * learning-loop check (which may store a proposal), then one summary refresh for whatever changed.
 * It never throws: a learning-loop problem must not change the result of the merchant's action.
 */
export function buildOutcomeHook(): (event: OutcomeEvent) => Promise<void> {
  return async (event) => {
    try {
      await runLearningLoop(event, buildLoopDeps());
    } catch {
      console.warn("[insights] the learning-loop check failed; the outcome itself was recorded");
    }
    await refreshInsightsSummary(event.sessionId);
  };
}
