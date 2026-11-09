/** Binds the learning loop to the real database, LLM layer and activity log. */
import { logActivity } from "@/lib/activity/logger";
import { getLlmDeps } from "@/lib/ai/runtime";
import { runLearningLoop, type LoopDeps, type OutcomeEvent } from "./loop";
import { createDrizzleInsightsRepo } from "./repo";

export function buildLoopDeps(): LoopDeps {
  return { repo: createDrizzleInsightsRepo(), ai: { llm: getLlmDeps() }, log: logActivity };
}

/**
 * The hook the dispute services call after an outcome was recorded (refund, Won, Lost). It never
 * throws: a learning-loop problem must not change the result of the merchant's action.
 */
export function buildOutcomeHook(): (event: OutcomeEvent) => Promise<void> {
  return async (event) => {
    try {
      await runLearningLoop(event, buildLoopDeps());
    } catch {
      console.warn("[insights] the learning-loop check failed; the outcome itself was recorded");
    }
  };
}
