/** Binds the order flow to the real database, PayPal client and environment. Used by the route handlers. */
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orders } from "@/db/schema";
import { logActivity } from "@/lib/activity/logger";
import { getLlmDeps } from "@/lib/ai/runtime";
import { createDrizzleEvidenceRepo } from "@/lib/evidence/repo";
import type { OrderEvidenceDeps } from "./evidence-service";
import { createDrizzleReadRepo } from "./queries";
import type { ShipDeps } from "./ship";
import { createDrizzleShipmentRepo } from "./ship-repo";
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

export function buildShipDeps(): ShipDeps {
  return {
    repo: createDrizzleShipmentRepo(),
    paypal: getPayPalClient(),
    demoMode: isDemoMode(),
    log: logActivity,
  };
}

export function buildOrderEvidenceDeps(): OrderEvidenceDeps {
  const read = createDrizzleReadRepo();
  return {
    findVisibleOrder: (orderId, sessionId) => read.findVisible(orderId, sessionId),
    evidence: createDrizzleEvidenceRepo(),
    // The evidence itself is append-only; only the order's cached score is refreshed.
    setCompleteness: async (orderId, completeness) => {
      await getDb().update(orders).set({ evidenceCompleteness: completeness }).where(eq(orders.id, orderId));
    },
    log: logActivity,
  };
}
