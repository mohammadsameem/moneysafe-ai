/** Binds the order flow to the real database, PayPal client and environment. Used by the route handlers. */
import { logActivity } from "@/lib/activity/logger";
import { getLlmDeps } from "@/lib/ai/runtime";
import { getAppBaseUrl } from "@/lib/env";
import { getPayPalClient, isDemoMode } from "@/lib/paypal";
import { createOrderAiHooks } from "./ai-hooks";
import { createDrizzleOrdersRepo } from "./repo";
import type { OrderDeps } from "./types";

export function buildOrderDeps(): OrderDeps {
  return {
    repo: createDrizzleOrdersRepo(),
    paypal: getPayPalClient(),
    demoMode: isDemoMode(),
    appBaseUrl: getAppBaseUrl(),
    log: logActivity,
    // The model is reachable only through getLlmDeps(): key check, then the per-session and daily
    // budget (checkLlmBudget), then the call. Without a key or budget every step is rule-based.
    ai: createOrderAiHooks({ llm: getLlmDeps() }),
  };
}
