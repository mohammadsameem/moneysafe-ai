/**
 * Approval state for a (dispute, action) pair (M2-04, REQ-DIS-08).
 *
 * `resolveApprovalState` is the ONE place that decides which of the three branches an approval
 * request is in. Everything else (the approve handler, the UI hint) branches on its answer.
 *
 *   already_executed  an approved record exists and its execution has `executed_at` set
 *   retry             an approved record exists with an UNEXECUTED execution (a live call failed)
 *   first             no approved record
 *
 * Only `first` ever inserts anything. `retry` and `already_executed` insert nothing, and `retry`
 * reuses the stored PayPal-Request-Id.
 */
import { randomUUID } from "node:crypto";
import type { ActionExecution, ApprovalRecord } from "@/db/schema";
import type { ApprovalsRepo, DisputeActionType, NewApprovalWithExecution } from "./types";

export type ApprovalState =
  | { kind: "already_executed"; approval: ApprovalRecord; execution: ActionExecution }
  | { kind: "retry"; approval: ApprovalRecord; execution: ActionExecution }
  | { kind: "first" };

export async function resolveApprovalState(
  repo: Pick<ApprovalsRepo, "findApprovedApproval" | "getExecutionByApproval">,
  disputeId: string,
  actionType: DisputeActionType,
): Promise<ApprovalState> {
  const approval = await repo.findApprovedApproval(disputeId, actionType);
  if (!approval) return { kind: "first" };

  const execution = await repo.getExecutionByApproval(approval.id);
  // The two rows are inserted in one transaction, so an approval without an execution means the
  // data is damaged. Fail loudly rather than quietly creating a second approval.
  if (!execution) throw new Error("data integrity: an approved record has no action_executions row");

  return execution.executedAt ? { kind: "already_executed", approval, execution } : { kind: "retry", approval, execution };
}

export type NewApprovalInput = Omit<NewApprovalWithExecution, "paypalRequestId">;

/**
 * Insert the approval and its execution in ONE transaction, with a FRESH PayPal-Request-Id that is
 * then reused unchanged on every retry. Throws ApprovalConflictError if another request approved
 * first (the partial unique index); the caller re-reads the state instead of inserting again.
 */
export function createApprovalWithExecution(
  repo: Pick<ApprovalsRepo, "insertApprovalWithExecution">,
  input: NewApprovalInput,
  newRequestId: () => string = randomUUID,
): Promise<{ approval: ApprovalRecord; execution: ActionExecution }> {
  return repo.insertApprovalWithExecution({ ...input, paypalRequestId: newRequestId() });
}
