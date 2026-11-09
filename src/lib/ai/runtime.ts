/** Binds callWithFallback's injected dependencies to the real provider config, budget guard and activity log. */
import { logActivity } from "@/lib/activity/logger";
import type { LlmDeps } from "./call-with-fallback";
import { getConfiguredProviders } from "./providers";
import { checkLlmBudget } from "./rate-limit";

export function getLlmDeps(): LlmDeps {
  return {
    isConfigured: () => getConfiguredProviders().length > 0,
    checkBudget: (sessionId) => checkLlmBudget(sessionId),
    logActivity,
  };
}
