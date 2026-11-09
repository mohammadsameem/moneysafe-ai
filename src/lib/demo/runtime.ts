/** Binds the demo utilities to the real database and activity log. */
import { logActivity } from "@/lib/activity/logger";
import { createDrizzleSimulationRepo } from "@/lib/disputes/repo";
import type { StartDemoDeps } from "./copies";

export function buildStartDemoDeps(): StartDemoDeps {
  return { repo: createDrizzleSimulationRepo(), log: logActivity };
}
