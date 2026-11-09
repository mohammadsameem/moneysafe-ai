/**
 * The no-write-without-approval invariant (requirements REQ-NFR-03, design 4.4).
 *
 * Every PayPal call that moves money or changes a dispute (submit evidence, accept claim) must
 * pass through requireApproval() first. An approval authorises exactly one thing: it must be an
 * APPROVED record, for THIS dispute, for THIS action. An approval for another dispute, another
 * action, or a rejection never authorises a write.
 *
 * Pure: the database lookup is injected, and this module imports nothing from src/db.
 */
import { ApprovalRequiredError } from "./errors";

export type DisputeActionType = "submit_evidence" | "accept_claim";

/** The fields of an approval_records row that the gate reads. */
export interface ApprovalRecordLite {
  id: string;
  disputeId: string;
  actionType: DisputeActionType;
  decision: "approved" | "rejected";
}

/** Looks up an approval record by id. Returns null/undefined when there is none. */
export type ApprovalLookup = (approvalRecordId: string) => Promise<ApprovalRecordLite | null | undefined>;

export async function requireApproval(
  lookup: ApprovalLookup,
  request: { approvalRecordId: string; disputeId: string; actionType: DisputeActionType },
): Promise<ApprovalRecordLite> {
  if (!request.approvalRecordId || request.approvalRecordId.trim() === "") {
    throw new ApprovalRequiredError("missing_id");
  }
  const record = await lookup(request.approvalRecordId);
  if (!record) throw new ApprovalRequiredError("not_found");
  if (record.decision !== "approved") throw new ApprovalRequiredError("not_approved");
  if (record.disputeId !== request.disputeId) throw new ApprovalRequiredError("dispute_mismatch");
  if (record.actionType !== request.actionType) throw new ApprovalRequiredError("action_mismatch");
  return record;
}
