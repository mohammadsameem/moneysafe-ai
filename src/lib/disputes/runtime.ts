/** Binds the dispute services to the real database, PayPal client, LLM layer and environment. */
import { logActivity } from "@/lib/activity/logger";
import { getLlmDeps } from "@/lib/ai/runtime";
import { getCostAssumptions, isDemoModeEnabled } from "@/lib/env";
import { getPayPalClient } from "@/lib/paypal";
import type { AnalyzeDeps } from "./analyze";
import type { ApproveDeps } from "./approve";
import type { DetailDeps } from "./detail";
import type { DisputeReadDeps } from "./read";
import { buildOutcomeHook } from "@/lib/insights/runtime";
import type { IngestDeps } from "./ingest";
import { createLiveGate } from "./live-gate";
import { createDrizzleDisputesRepo, createDrizzleIngestRepo, createDrizzleSimulationRepo } from "./repo";
import type { SimulationDeps } from "./simulate";

export function buildReadDeps(): DisputeReadDeps {
  return {
    repo: createDrizzleDisputesRepo(),
    paypal: getPayPalClient(),
    demoMode: isDemoModeEnabled(),
    log: logActivity,
  };
}

export function buildDetailDeps(): DetailDeps {
  return {
    repo: createDrizzleDisputesRepo(),
    paypal: getPayPalClient(),
    demoMode: isDemoModeEnabled(),
    log: logActivity,
  };
}

export function buildApproveDeps(): ApproveDeps {
  return {
    repo: createDrizzleDisputesRepo(),
    executor: {
      paypal: getPayPalClient(),
      demoMode: isDemoModeEnabled(),
      log: logActivity,
      // A refund is an outcome: count it, then check whether it is time to propose weights.
      onOutcomeRecorded: buildOutcomeHook(),
    },
    log: logActivity,
    // A real PayPal dispute is acted on only if PayPal allows that action right now (and is never simulated).
    liveGate: createLiveGate(getPayPalClient(), isDemoModeEnabled()),
  };
}

export function buildIngestDeps(): IngestDeps {
  return { repo: createDrizzleIngestRepo(), paypal: getPayPalClient(), demoMode: isDemoModeEnabled(), log: logActivity };
}

export function buildSimulationDeps(): SimulationDeps {
  return {
    repo: createDrizzleSimulationRepo(),
    demoMode: isDemoModeEnabled(),
    log: logActivity,
    // Won / Lost are outcomes too: the same learning-loop check as for refunds.
    onOutcomeRecorded: buildOutcomeHook(),
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
