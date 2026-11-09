/**
 * "Start demo" (M3-08): this session's own copies of the open seed disputes SEED-C, SEED-D and
 * SEED-E.
 *
 * The seeds are shared by every session, so they are read-only examples: approving one would change
 * it for everyone. A copy is an ordinary demo dispute (`is_demo = true`, `is_seed = false`,
 * `session_id` = the caller) on the SAME order (so the same evidence), with the seed's stored
 * analysis and a concrete deadline at now + the seed's offset. No model is called: it is instant.
 *
 * The copy id is derived from (session, seed) (see ./ids), and the insert is ON CONFLICT DO
 * NOTHING, so a second click, or two at once, creates nothing new and returns the same copies.
 */
import type { Dispute } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { isAnalysed } from "@/lib/disputes/analysis-state";
import type { SimulationRepo } from "@/lib/disputes/simulate";
import { SHARED_EXAMPLE_KEYS, demoCopyId, sharedExampleId, type SharedExampleKey } from "./ids";

export { SHARED_EXAMPLE_KEYS, demoCopyId, sharedExampleId } from "./ids";

export { SHARED_EXAMPLE_MESSAGE } from "./messages";

const HOUR_MS = 3_600_000;

export type StartDemoRepo = Pick<SimulationRepo, "findDisputeById" | "insertDisputeIfAbsent">;

export interface StartDemoDeps {
  repo: StartDemoRepo;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
}

export interface DemoCopy {
  key: SharedExampleKey;
  seedDisputeId: string;
  disputeId: string;
  /** False when this session already had the copy. */
  created: boolean;
}

export type StartDemoResult = { kind: "ok"; copies: DemoCopy[]; created: number } | { kind: "seed_missing"; key: SharedExampleKey };

/** The copy row for one seed: same order, evidence references, reason, amount and stored analysis. */
export function buildDemoCopy(seed: Dispute, sessionId: string, now: Date): Dispute {
  const offset = seed.deadlineOffsetHours ?? 72;
  const stamp = now.toISOString();
  return {
    ...seed,
    id: demoCopyId(sessionId, seed.id),
    paypalDisputeId: null,
    status: "open",
    outcome: null,
    outcomeIsSimulated: false,
    deadlineOffsetHours: offset,
    // Concrete, so the copy's countdown really counts down (offsets are only re-applied to seeds).
    deadlineAt: new Date(now.getTime() + offset * HOUR_MS).toISOString(),
    analysisComputedAt: isAnalysed(seed.analysisComputedAt) ? stamp : null,
    sessionId,
    isSeed: false,
    isDemo: true,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export async function startDemo(sessionId: string, deps: StartDemoDeps): Promise<StartDemoResult> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();

  // Read every seed first, so a missing one creates nothing at all.
  const seeds: { key: SharedExampleKey; seed: Dispute }[] = [];
  for (const key of SHARED_EXAMPLE_KEYS) {
    const seed = await deps.repo.findDisputeById(sharedExampleId(key));
    if (!seed || !seed.isSeed) return { kind: "seed_missing", key };
    seeds.push({ key, seed });
  }

  const copies: DemoCopy[] = [];
  for (const { key, seed } of seeds) {
    const copy = buildDemoCopy(seed, sessionId, now);
    const created = await deps.repo.insertDisputeIfAbsent(copy);
    copies.push({ key, seedDisputeId: seed.id, disputeId: copy.id, created });
  }

  const created = copies.filter((c) => c.created).length;
  if (created > 0) {
    try {
      await deps.log?.({
        sessionId,
        stepType: "merchant_action",
        toolName: "start_demo",
        inputSummary: `copy ${SHARED_EXAMPLE_KEYS.join(", ")} for this session`,
        outputSummary: `${created} demo dispute(s) created with their stored analysis; no model call`,
        durationMs: Date.now() - started,
        status: "simulated",
      });
    } catch {
      /* logging is best effort */
    }
  }
  return { kind: "ok", copies, created };
}
