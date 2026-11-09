import { draftVerification, explainRisk, type ExplainerDeps } from "@/lib/ai/risk-explainer";
import type { OrderAiHooks } from "./types";

/**
 * Adapts the risk explainer to the order flow's hook interface. `deps.llm` decides whether a
 * model is ever called (key, budget, logging), so binding this into the order flow is where the
 * LLM budget guard must already exist (M1-09b).
 */
export function createOrderAiHooks(deps: ExplainerDeps): OrderAiHooks {
  return {
    async explainRisk(order, ctx) {
      const { value, usedFallback } = await explainRisk(order, ctx, deps);
      return { text: value, usedFallback };
    },
    async draftVerification(order, ctx) {
      const { value, usedFallback } = await draftVerification(order, ctx, deps);
      return { draft: value, usedFallback };
    },
  };
}
