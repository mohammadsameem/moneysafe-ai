/**
 * The merchant's decision on a pending weight proposal (M4-02, REQ-LL-02).
 *
 * Approve applies it: active <- proposed, proposal cleared, counter reset to 0. It affects orders
 * scored from now on; scores already stored do not change. Reject clears it and leaves the counter
 * where it was. Either way the merchant must send back the `proposalCreatedAt` of the proposal
 * they were looking at, so a proposal that was replaced in the meantime can never be decided by
 * mistake.
 */
import type { ActivityMeta } from "@/lib/activity/logger";
import { toSignalWeightValues } from "@/lib/orders/weights";
import type { InsightsRepo } from "./types";
import { proposedWeights, weightChanges } from "./weights";

export interface DecideDeps {
  repo: InsightsRepo;
  log?: (meta: ActivityMeta) => Promise<void>;
}

export type DecideResult =
  | { kind: "applied"; changes: number }
  | { kind: "rejected" }
  /** No proposal is pending (already decided, or never created). */
  | { kind: "no_proposal" }
  /** A different proposal is pending than the one the merchant saw. */
  | { kind: "proposal_changed" }
  /** The database has no active weights row. */
  | { kind: "not_seeded" };

export interface DecideRequest {
  sessionId: string;
  /** The `proposalCreatedAt` the merchant was shown. */
  proposalCreatedAt: string;
}

async function decide(kind: "approve" | "reject", req: DecideRequest, deps: DecideDeps): Promise<DecideResult> {
  const started = Date.now();
  const row = await deps.repo.getActiveWeights();
  if (!row) return { kind: "not_seeded" };
  const proposed = proposedWeights(row);
  if (!proposed || row.proposalCreatedAt === null) return { kind: "no_proposal" };
  if (row.proposalCreatedAt !== req.proposalCreatedAt) return { kind: "proposal_changed" };

  const changes = weightChanges(toSignalWeightValues(row), proposed);
  const updated = kind === "approve" ? await deps.repo.applyProposal(row.id, req.proposalCreatedAt) : await deps.repo.rejectProposal(row.id, req.proposalCreatedAt);
  // The conditional update matched nothing: another request decided (or replaced) it first.
  if (!updated) return { kind: "no_proposal" };

  try {
    await deps.log?.({
      sessionId: req.sessionId,
      stepType: "merchant_action",
      toolName: kind === "approve" ? "approve_weight_change" : "reject_weight_change",
      inputSummary: `${kind} the pending weight proposal (${changes.map((c) => `${c.signal} ${c.from}->${c.to}`).join(", ") || "no changes"})`,
      outputSummary:
        kind === "approve"
          ? "weights updated for orders scored from now on; counter reset"
          : "proposal discarded; weights unchanged; counter kept",
      durationMs: Date.now() - started,
      status: "success",
    });
  } catch {
    /* logging is best effort */
  }
  return kind === "approve" ? { kind: "applied", changes: changes.length } : { kind: "rejected" };
}

export const approveWeights = (req: DecideRequest, deps: DecideDeps): Promise<DecideResult> => decide("approve", req, deps);
export const rejectWeights = (req: DecideRequest, deps: DecideDeps): Promise<DecideResult> => decide("reject", req, deps);
