/**
 * Approval-gated PayPal dispute writes (design 4.4).
 *
 * submitEvidence and acceptClaim are the ONLY way the app moves a dispute forward, and each runs
 * requireApproval() before anything else, so no PayPal request (live or simulated) can happen
 * without a matching approved approval record. `execute` is deliberately not exported from the
 * PayPal module: it is supplied by the approve handler, after the approval record exists.
 *
 * M2-05 builds the real `execute` (loads the action_executions row, simulates or calls PayPal
 * with the stored PayPal-Request-Id, records the result). The read functions (listDisputes,
 * getDispute) arrive in M2-01.
 */
import { requireApproval, type ApprovalLookup } from "./approval-gate";

/** PayPal provide-evidence body (design 4.5). */
export interface ProvideEvidencePayload {
  evidences: {
    evidence_type: string;
    evidence_info?: {
      tracking_info: { carrier_name: string; carrier_name_other?: string; tracking_number: string; tracking_url?: string }[];
    };
    documents?: { name: string }[];
    notes?: string;
    date?: string;
  }[];
}

/** PayPal accept-claim body (design 4.5). */
export interface AcceptClaimPayload {
  note: string;
  accept_claim_type: "REFUND";
}

export type PayPalDisputeWrite =
  | { kind: "submit_evidence"; disputeId: string; body: ProvideEvidencePayload }
  | { kind: "accept_claim"; disputeId: string; body: AcceptClaimPayload };

export interface DisputeWriteDeps {
  lookupApproval: ApprovalLookup;
  /** Performs the PayPal call (live HTTP or simulation). Only ever reached through the gate. */
  execute: (call: PayPalDisputeWrite) => Promise<unknown>;
}

/** Submit evidence for a dispute. Throws ApprovalRequiredError, before any PayPal call, without approval. */
export async function submitEvidence(
  disputeId: string,
  evidence: ProvideEvidencePayload,
  approvalRecordId: string,
  deps: DisputeWriteDeps,
): Promise<unknown> {
  await requireApproval(deps.lookupApproval, { approvalRecordId, disputeId, actionType: "submit_evidence" });
  return deps.execute({ kind: "submit_evidence", disputeId, body: evidence });
}

/** Accept a claim (refund). Throws ApprovalRequiredError, before any PayPal call, without approval. */
export async function acceptClaim(
  disputeId: string,
  note: string,
  approvalRecordId: string,
  deps: DisputeWriteDeps,
): Promise<unknown> {
  await requireApproval(deps.lookupApproval, { approvalRecordId, disputeId, actionType: "accept_claim" });
  return deps.execute({ kind: "accept_claim", disputeId, body: { note, accept_claim_type: "REFUND" } });
}
