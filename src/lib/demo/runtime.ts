/** Binds the demo utilities to the real database, activity log and (for the reset) the Insights summary. */
import { logActivity } from "@/lib/activity/logger";
import { createDrizzleSimulationRepo } from "@/lib/disputes/repo";
import { refreshInsightsSummary } from "@/lib/insights/runtime";
import type { StartDemoDeps } from "./copies";
import type { RestartDeps, ResetDeps } from "./reset";
import { createDrizzleRestartStore, createDrizzleResetStore } from "./store";

export function buildStartDemoDeps(): StartDemoDeps {
  return { repo: createDrizzleSimulationRepo(), log: logActivity };
}

export function buildResetDeps(): ResetDeps {
  // The seeded Insights cache matches the re-seeded data, so this refresh is a cache hit (no model call).
  return { store: createDrizzleResetStore(), afterReset: (sessionId) => refreshInsightsSummary(sessionId) };
}

export function buildRestartDeps(): RestartDeps {
  return { store: createDrizzleRestartStore() };
}
