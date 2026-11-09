import { describe, expect, it, vi } from "vitest";
import { ApprovalRequiredError } from "../errors";
import type { ApprovalLookup, ApprovalRecordLite } from "../approval-gate";
import { acceptClaim, submitEvidence, type ProvideEvidencePayload } from "../disputes";

const DISPUTE = "dispute-1";
const EVIDENCE: ProvideEvidencePayload = {
  evidences: [
    {
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "USPS", tracking_number: "9400111899223197428490" }] },
    },
  ],
};

const approved = (over: Partial<ApprovalRecordLite> = {}): ApprovalRecordLite => ({
  id: "appr-1",
  disputeId: DISPUTE,
  actionType: "submit_evidence",
  decision: "approved",
  ...over,
});

/** A fake approval_records table lookup plus a spy standing in for the real PayPal call. */
function setup(row: ApprovalRecordLite | null | undefined) {
  const lookupApproval = vi.fn<ApprovalLookup>(async () => row);
  const execute = vi.fn(async () => ({ ok: true }));
  return { deps: { lookupApproval, execute }, lookupApproval, execute };
}

describe("no PayPal write without a stored approval record (REQ-NFR-03)", () => {
  it("submitEvidence: no approval row -> throws ApprovalRequiredError and never reaches PayPal", async () => {
    const { deps, execute } = setup(null);

    const err = await submitEvidence(DISPUTE, EVIDENCE, "appr-1", deps).catch((e) => e);

    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect(err).toMatchObject({ reason: "not_found" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("acceptClaim: no approval row -> throws ApprovalRequiredError and never reaches PayPal", async () => {
    const { deps, execute } = setup(undefined);

    const err = await acceptClaim(DISPUTE, "Refunding in full.", "appr-1", deps).catch((e) => e);

    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect(err).toMatchObject({ reason: "not_found" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("an approved row for this dispute and action lets the PayPal call proceed, exactly once", async () => {
    const submit = setup(approved());
    await expect(submitEvidence(DISPUTE, EVIDENCE, "appr-1", submit.deps)).resolves.toEqual({ ok: true });
    expect(submit.execute).toHaveBeenCalledTimes(1);
    expect(submit.execute).toHaveBeenCalledWith({ kind: "submit_evidence", disputeId: DISPUTE, body: EVIDENCE });

    const accept = setup(approved({ actionType: "accept_claim" }));
    await expect(acceptClaim(DISPUTE, "Refunding in full.", "appr-1", accept.deps)).resolves.toEqual({ ok: true });
    expect(accept.execute).toHaveBeenCalledTimes(1);
    expect(accept.execute).toHaveBeenCalledWith({
      kind: "accept_claim",
      disputeId: DISPUTE,
      body: { note: "Refunding in full.", accept_claim_type: "REFUND" },
    });
  });
});

describe("an approval only authorises exactly what was approved", () => {
  it("a REJECTED record never authorises a write", async () => {
    const { deps, execute } = setup(approved({ decision: "rejected" }));
    const err = await submitEvidence(DISPUTE, EVIDENCE, "appr-1", deps).catch((e) => e);
    expect(err).toMatchObject({ name: "ApprovalRequiredError", reason: "not_approved" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("an approval for a different dispute does not authorise this dispute", async () => {
    const { deps, execute } = setup(approved({ disputeId: "some-other-dispute" }));
    const err = await submitEvidence(DISPUTE, EVIDENCE, "appr-1", deps).catch((e) => e);
    expect(err).toMatchObject({ name: "ApprovalRequiredError", reason: "dispute_mismatch" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("an approval for another action does not authorise this action (accept_claim approval cannot submit evidence)", async () => {
    const { deps, execute } = setup(approved({ actionType: "accept_claim" }));
    const err = await submitEvidence(DISPUTE, EVIDENCE, "appr-1", deps).catch((e) => e);
    expect(err).toMatchObject({ name: "ApprovalRequiredError", reason: "action_mismatch" });
    expect(execute).not.toHaveBeenCalled();

    const other = setup(approved({ actionType: "submit_evidence" }));
    const err2 = await acceptClaim(DISPUTE, "Refund", "appr-1", other.deps).catch((e) => e);
    expect(err2).toMatchObject({ reason: "action_mismatch" });
    expect(other.execute).not.toHaveBeenCalled();
  });

  it("an empty approval id is refused without even querying the database", async () => {
    const { deps, lookupApproval, execute } = setup(approved());
    const err = await acceptClaim(DISPUTE, "Refund", "  ", deps).catch((e) => e);
    expect(err).toMatchObject({ name: "ApprovalRequiredError", reason: "missing_id" });
    expect(lookupApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("a lookup failure blocks the write too (fail closed)", async () => {
    const execute = vi.fn();
    const deps = { lookupApproval: vi.fn(async () => Promise.reject(new Error("db down"))), execute };
    await expect(submitEvidence(DISPUTE, EVIDENCE, "appr-1", deps)).rejects.toThrow("db down");
    expect(execute).not.toHaveBeenCalled();
  });
});
