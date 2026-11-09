/** Binds the dispute services to the real database, PayPal client, LLM layer and environment. */
import { logActivity } from "@/lib/activity/logger";
import { getLlmDeps } from "@/lib/ai/runtime";
import { getCostAssumptions, isDemoModeEnabled } from "@/lib/env";
import { getPayPalClient } from "@/lib/paypal";
import type { AnalyzeDeps } from "./analyze";
import type { DisputeReadDeps } from "./read";
import { createDrizzleDisputesRepo } from "./repo";

export function buildReadDeps(): DisputeReadDeps {
  return {
    repo: createDrizzleDisputesRepo(),
    paypal: getPayPalClient(),
    demoMode: isDemoModeEnabled(),
    log: logActivity,
  };
}

export function buildAnalyzeDeps(): AnalyzeDeps {
  return {
    repo: createDrizzleDisputesRepo(),
    // The model is reachable only through getLlmDeps(): key check, then the per-session and daily
    // budget, then the call. Without a key or budget the system's own result is stored.
    explainer: { llm: getLlmDeps() },
    costs: getCostAssumptions(),
    log: logActivity,
  };
}
