/**
 * The learning-loop trigger (M4-01, REQ-LL-02). Called after a dispute outcome was recorded.
 *
 * The outcome insert and the counter bump already happened, together, in one transaction (see
 * completeExecution and recordSimulatedOutcome). This module receives the counter value THAT
 * bump produced, so two outcomes recorded at the same moment cannot both (or neither) cross a
 * multiple of 5.
 *
 *   counter is not a multiple of 5      nothing to do
 *   multiple of 5, a proposal pending   log rule_engine "proposal_skipped_pending"; no model call;
 *                                       the counter is NOT reset (it keeps counting)
 *   multiple of 5, none pending         ask the model for weights (last 20 outcomes), cap them,
 *                                       store the proposal as pending, reset the counter to 0
 *
 * Nothing here changes a live weight: a proposal only becomes active when the merchant approves it.
 */
import type { ActivityMeta } from "@/lib/activity/logger";
import { proposeWeightChanges } from "@/lib/ai/insights";
import type { ExplainerDeps } from "@/lib/ai/risk-explainer";
import type { OutcomeRecordedEvent } from "@/lib/disputes/types";
import { toSignalWeightValues } from "@/lib/orders/weights";
import type { InsightsRepo } from "./types";
import { OUTCOMES_FOR_PROPOSAL, PROPOSAL_EVERY, hasWeightChange, weightChanges } from "./weights";

/** `counterAfter` is signal_weights.resolved_since_last_proposal right after THIS outcome was counted (null if it was not). */
export type OutcomeEvent = OutcomeRecordedEvent;

export interface LoopDeps {
  repo: InsightsRepo;
  ai: ExplainerDeps;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
}

export type LoopResult =
  | { kind: "not_due" }
  | { kind: "skipped_pending" }
  | { kind: "proposed"; changes: number; capped: boolean }
  /** The model saw no reason to change a weight. Counter reset, nothing stored. */
  | { kind: "no_change" }
  /** The model was unavailable. Nothing stored, counter unchanged. */
  | { kind: "ai_unavailable" };

export async function runLearningLoop(event: OutcomeEvent, deps: LoopDeps): Promise<LoopResult> {
  const counter = event.counterAfter;
  if (counter === null || counter <= 0 || counter % PROPOSAL_EVERY !== 0) return { kind: "not_due" };

  const started = Date.now();
  const rule = async (toolName: string, inputSummary: string, outputSummary: string, status: ActivityMeta["status"]) => {
    try {
      await deps.log?.({ sessionId: event.sessionId, refDisputeId: event.disputeId, stepType: "rule_engine", toolName, inputSummary, outputSummary, durationMs: Date.now() - started, status });
    } catch {
      /* logging is best effort */
    }
  };

  const row = await deps.repo.getActiveWeights();
  if (!row) return { kind: "not_due" };

  // REQ-LL-02: a proposal is already waiting for the merchant. Keep counting, do not ask again.
  if (row.proposalCreatedAt !== null) {
    await rule("proposal_skipped_pending", `${counter} resolved since the last proposal`, "a weight proposal is already pending; no new one was requested and the counter keeps counting", "success");
    return { kind: "skipped_pending" };
  }

  const current = toSignalWeightValues(row);
  const outcomes = await deps.repo.listRecentOutcomes(OUTCOMES_FOR_PROPOSAL);
  const proposal = await proposeWeightChanges(outcomes, current, { sessionId: event.sessionId }, deps.ai);

  if (proposal.usedFallback) {
    // "Unchanged weights with a note": there is nothing to approve, so nothing is stored.
    await rule("proposal_skipped_ai_unavailable", `${counter} resolved since the last proposal`, `AI unavailable (${proposal.reason ?? "unknown"}); weights unchanged, no proposal stored`, "fallback");
    return { kind: "ai_unavailable" };
  }

  if (!hasWeightChange(current, proposal.weights)) {
    await deps.repo.resetCounter(row.id);
    await rule("proposal_no_change", `${outcomes.length} recent outcomes reviewed`, "the model proposed no change to any weight; nothing to approve, counter reset", "success");
    return { kind: "no_change" };
  }

  const stored = await deps.repo.storeProposal({
    weightsId: row.id,
    proposed: proposal.weights,
    reasoning: proposal.reasoning,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  if (!stored) {
    // Someone stored a proposal between our check and our write: same as "already pending".
    await rule("proposal_skipped_pending", `${counter} resolved since the last proposal`, "a weight proposal was stored by another request; this one was dropped", "success");
    return { kind: "skipped_pending" };
  }

  const changes = weightChanges(current, proposal.weights);
  await rule(
    "weight_proposal_created",
    `${outcomes.length} recent outcomes reviewed`,
    `${changes.length} weight change(s) proposed (${changes.map((c) => `${c.signal} ${c.from}->${c.to}`).join(", ")}); waiting for the merchant's approval; counter reset`,
    "success",
  );
  return { kind: "proposed", changes: changes.length, capped: proposal.capped };
}
