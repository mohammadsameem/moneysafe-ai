import { describe, expect, it, vi, type Mock } from "vitest";
import type { ActivityMeta } from "@/lib/activity/logger";
import { PayPalError, type PayPalClient } from "@/lib/paypal";
import { SEED_C, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import { createApprovalWithExecution, resolveApprovalState } from "../approval";
import { approveDispute, expectedAction, hashPayload, rejectDispute, stableStringify, type ApproveDeps, type ApproveRequest } from "../approve";
import { DISPUTE_ID, NOW, ORDER_ID, OTHER_SESSION, SESSION, analysed, createFakeDisputesRepo, makeRecord } from "./fakes";

type DisputeOver = Parameters<typeof analysed>[0];
type ScriptedPayPal = PayPalClient & { request: PayPalClient["request"] & Mock };

const DRAFT = "Hello PayPal Dispute Team,\n\nThe parcel was delivered under tracking 9400111899223197428490.\n\nThank you,\n[Your name]";
const ok = {}; // PayPal answers 200 with a body we do not use

/** A PayPal client that answers each call from a script: an Error is thrown, anything else is the response body. */
function scripted(...steps: unknown[]): ScriptedPayPal {
  const queue = [...steps];
  const request = vi.fn(async (_path: string, _init: unknown, schema: { parse(v: unknown): unknown }) => {
    const next = queue.length > 0 ? queue.shift() : ok;
    if (next instanceof Error) throw next;
    return schema.parse(next);
  });
  return { request } as unknown as ScriptedPayPal;
}
const sentRequestIds = (p: ScriptedPayPal) => p.request.mock.calls.map((c) => (c[1] as { requestId?: string }).requestId);
const sentBody = (p: ScriptedPayPal, n = 0) => (p.request.mock.calls[n]?.[1] as { body: Record<string, unknown> }).body;
const sentPath = (p: ScriptedPayPal, n = 0) => String(p.request.mock.calls[n]?.[0]);

const contestDispute = (over: DisputeOver = {}) =>
  analysed({ isSeed: false, isDemo: false, paypalDisputeId: "PP-D-1", finalRecommendation: "contest", systemRecommendation: "contest", draftResponse: DRAFT, ...over });
const refundDispute = (over: DisputeOver = {}) =>
  analysed({ isSeed: false, isDemo: false, paypalDisputeId: "PP-D-1", finalRecommendation: "refund", systemRecommendation: "refund", winProbability: 0.27, draftResponse: null, ...over });

function setup(dispute = contestDispute(), paypal: ScriptedPayPal | null = scripted(), over: Partial<ApproveDeps> = {}) {
  const repo = createFakeDisputesRepo([makeRecord(dispute)], artefactRows(ORDER_ID, SEED_C));
  const logs: ActivityMeta[] = [];
  let n = 0;
  const deps: ApproveDeps = {
    repo,
    executor: { paypal, demoMode: false, now: () => NOW, log: async (m) => void logs.push(m) },
    newRequestId: () => `fresh-request-id-${++n}`,
    now: () => NOW,
    log: async (m) => void logs.push(m),
    ...over,
  };
  return { repo, paypal, deps, logs };
}

const approve = (deps: ApproveDeps, over: Partial<ApproveRequest> = {}) =>
  approveDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "demo-merchant", action: "submit_evidence", ...over }, deps);
const refund = (deps: ApproveDeps, over: Partial<ApproveRequest> = {}) => approve(deps, { action: "accept_claim", ...over });
const snapshotInserts = (repo: ReturnType<typeof createFakeDisputesRepo>) => ({ ...repo.inserts });

describe("approve branching (REQ-DIS-08): the tests listed in M2-04", () => {
  it("first: no records → inserts exactly 1 approval + 1 execution; PayPal called once with the new paypal_request_id", async () => {
    const { repo, paypal, deps } = setup();
    expect(repo.approvals).toHaveLength(0);

    const result = await approve(deps);

    expect(result).toMatchObject({ kind: "executed", simulated: false, retried: false });
    expect(repo.inserts).toEqual({ approvals: 1, executions: 1, rejections: 0 });
    expect(repo.approvals[0]).toMatchObject({ disputeId: DISPUTE_ID, actionType: "submit_evidence", decision: "approved", merchantUserId: "demo-merchant" });
    expect(repo.executions[0]?.paypalRequestId).toBe("fresh-request-id-1");
    expect(paypal!.request).toHaveBeenCalledTimes(1);
    expect(sentRequestIds(paypal!)).toEqual(["fresh-request-id-1"]);
    expect(sentPath(paypal!)).toBe("/v1/customer/disputes/PP-D-1/provide-evidence");
    expect(repo.executions[0]?.executedAt).toBe(NOW.toISOString());
  });

  it("retry path: approved record + unexecuted execution (previous PayPal call failed) → inserts 0 rows; PayPal called once with the same paypal_request_id as the stored row; on success executed_at is set", async () => {
    const { repo, paypal, deps } = setup(contestDispute(), scripted(new PayPalError("PayPal could not be reached"), ok));

    const first = await approve(deps);
    expect(first.kind).toBe("execution_failed");
    expect(repo.executions[0]?.executedAt).toBeNull();
    const storedId = repo.executions[0]!.paypalRequestId;
    const before = snapshotInserts(repo);
    paypal!.request.mockClear();
    // (mockClear keeps the script's remaining step, which is the success)

    const second = await approve(deps);

    expect(second).toMatchObject({ kind: "executed", retried: true });
    expect(snapshotInserts(repo)).toEqual(before); // 0 rows inserted by the retry
    expect(paypal!.request).toHaveBeenCalledTimes(1);
    expect(sentRequestIds(paypal!)).toEqual([storedId]);
    expect(repo.executions).toHaveLength(1);
    expect(repo.executions[0]?.executedAt).toBe(NOW.toISOString());
  });

  it("retry then fail again → still 0 inserts; executed_at stays null; same request id", async () => {
    const { repo, paypal, deps } = setup(contestDispute(), scripted(new PayPalError("down 1"), new PayPalError("down 2"), new PayPalError("down 3")));

    await approve(deps);
    const before = snapshotInserts(repo);
    const second = await approve(deps);
    const third = await approve(deps);

    expect(second).toMatchObject({ kind: "execution_failed", message: "down 2" });
    expect(third).toMatchObject({ kind: "execution_failed", message: "down 3" });
    expect(snapshotInserts(repo)).toEqual(before);
    expect(repo.executions[0]?.executedAt).toBeNull();
    expect(new Set(sentRequestIds(paypal!))).toEqual(new Set(["fresh-request-id-1"])); // every attempt used the one stored id
    expect(paypal!.request).toHaveBeenCalledTimes(3);
  });

  it("already_executed: executed row → 0 inserts, PayPal not called, returns the already-executed result", async () => {
    const { repo, paypal, deps } = setup();
    await approve(deps);
    const before = snapshotInserts(repo);
    paypal!.request.mockClear();

    const again = await approve(deps);

    expect(again).toMatchObject({ kind: "already_executed", execution: { executedAt: NOW.toISOString(), isSimulated: false } });
    expect(snapshotInserts(repo)).toEqual(before);
    expect(paypal!.request).not.toHaveBeenCalled();
  });

  it("concurrent first approval (unique violation on insert) → resolves to retry or already_executed, never a second execution row", async () => {
    // The other request approved first and its call has not finished: we continue it as a retry.
    const a = setup();
    a.repo.raceNextApproval({ executed: false });
    const resolvedToRetry = await approve(a.deps);
    expect(resolvedToRetry).toMatchObject({ kind: "executed", retried: true });
    expect(a.repo.executions).toHaveLength(1);
    expect(a.repo.approvals).toHaveLength(1);
    expect(sentRequestIds(a.paypal!)).toEqual([a.repo.executions[0]!.paypalRequestId]); // the rival's id, not ours
    expect(a.repo.executions[0]!.paypalRequestId).not.toBe("fresh-request-id-1");

    // The other request approved AND finished: nothing to do.
    const b = setup();
    b.repo.raceNextApproval({ executed: true });
    const resolvedToDone = await approve(b.deps);
    expect(resolvedToDone.kind).toBe("already_executed");
    expect(b.repo.executions).toHaveLength(1);
    expect(b.paypal!.request).not.toHaveBeenCalled();
  });

  it("accept_claim success → exactly one dispute_outcomes row (refunded) and one counter increment; the retry branch does not double-increment", async () => {
    const { repo, deps } = setup(refundDispute(), scripted(new PayPalError("PayPal could not be reached"), ok));

    const failed = await refund(deps);
    expect(failed.kind).toBe("execution_failed");
    expect(repo.outcomes).toHaveLength(0);
    expect(repo.counter.value).toBe(0);

    const retried = await refund(deps);
    expect(retried).toMatchObject({ kind: "executed", retried: true, outcomeRecorded: true });
    expect(repo.outcomes).toEqual([expect.objectContaining({ disputeId: DISPUTE_ID, outcome: "refunded", isSimulated: false })]);
    expect(repo.counter.value).toBe(1);

    const third = await refund(deps);
    expect(third.kind).toBe("already_executed");
    expect(repo.outcomes).toHaveLength(1);
    expect(repo.counter.value).toBe(1);
    expect(repo.records[0]?.dispute).toMatchObject({ status: "resolved_refunded", outcome: "refunded" });
  });
});

describe("approve: concurrency", () => {
  it("two simultaneous approvals: one approval row, one execution row, every PayPal call uses the one request id, the refund counts once", async () => {
    const { repo, paypal, deps } = setup(refundDispute());
    const [a, b] = await Promise.all([refund(deps), refund(deps)]);

    expect(repo.approvals).toHaveLength(1);
    expect(repo.executions).toHaveLength(1);
    expect(new Set(sentRequestIds(paypal!)).size).toBe(1);
    expect(repo.outcomes).toHaveLength(1);
    expect(repo.counter.value).toBe(1);
    expect([a.kind, b.kind]).toContain("executed");
    for (const r of [a, b]) expect(["executed", "already_executed"]).toContain(r.kind);
  });
});

describe("approve: simulation on seeded and demo disputes", () => {
  it("a seeded contest: approval stored, nothing sent to PayPal, executed as simulated, dispute becomes 'action_taken'", async () => {
    const { repo, paypal, deps } = setup(contestDispute({ isSeed: true, paypalDisputeId: null, sessionId: null }));
    const result = await approve(deps);
    expect(result).toMatchObject({ kind: "executed", simulated: true, execution: { isSimulated: true }, view: { status: "action_taken" } });
    expect(paypal!.request).not.toHaveBeenCalled();
    expect(repo.inserts.approvals).toBe(1); // still needs an approval record (REQ-NFR-03)
    expect(repo.outcomes).toHaveLength(0);
  });

  it("a seeded refund: simulated, resolved as refunded with a simulated outcome", async () => {
    const { repo, deps } = setup(refundDispute({ isSeed: true, paypalDisputeId: null, sessionId: null }));
    const result = await refund(deps);
    expect(result).toMatchObject({ kind: "executed", simulated: true, outcomeRecorded: true, view: { status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: true } });
    expect(repo.counter.value).toBe(1);
  });

  it("DEMO_MODE simulates a live-linked dispute too", async () => {
    const { paypal, deps } = setup(contestDispute(), scripted(), { executor: { paypal: scripted(), demoMode: true, now: () => NOW } });
    expect((await approve(deps)).kind).toBe("executed");
    expect(paypal!.request).not.toHaveBeenCalled();
  });
});

describe("approve: edits, payload and hash", () => {
  it("an edited draft is recorded alongside the original, and the edited text is what is sent", async () => {
    const { repo, paypal, deps } = setup();
    await approve(deps, { editedDraft: "  My own wording.  " });

    expect(repo.executions[0]).toMatchObject({ originalDraft: DRAFT, editedDraft: "My own wording." });
    const evidence = (sentBody(paypal!) as { evidences: { evidence_type: string; notes: string }[] }).evidences[0]!;
    expect(evidence).toMatchObject({ evidence_type: "PROOF_OF_FULFILLMENT", notes: "My own wording." });
    expect(repo.executions[0]?.approvedPayload).toEqual(sentBody(paypal!));
  });

  it("an 'edit' that changes nothing, or is blank, is not recorded as an edit", async () => {
    for (const editedDraft of [DRAFT, `  ${DRAFT}\n`, "   ", "", null, undefined]) {
      const { repo, deps } = setup();
      await approve(deps, { editedDraft });
      expect(repo.executions[0]?.editedDraft, JSON.stringify(editedDraft)).toBeNull();
      expect(repo.executions[0]?.originalDraft).toBe(DRAFT);
    }
  });

  it("the approval stores the SHA-256 of the payload, which differs for an edited draft and is stable under key order", async () => {
    const plain = setup();
    await approve(plain.deps);
    const edited = setup();
    await approve(edited.deps, { editedDraft: "Different words." });

    const hash = plain.repo.approvals[0]!.payloadHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashPayload("submit_evidence", plain.repo.executions[0]!.approvedPayload));
    expect(edited.repo.approvals[0]!.payloadHash).not.toBe(hash);
    expect(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(stableStringify({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }));
    expect(hashPayload("submit_evidence", { x: 1 })).not.toBe(hashPayload("accept_claim", { x: 1 }));
  });

  it("a retry sends the STORED payload, ignoring a different draft in the retry request", async () => {
    const { repo, paypal, deps } = setup(contestDispute(), scripted(new PayPalError("down"), ok));
    await approve(deps);
    const stored = JSON.stringify(repo.executions[0]!.approvedPayload);

    await approve(deps, { editedDraft: "A completely different draft." });

    expect(JSON.stringify(sentBody(paypal!, 0))).toBe(stored);
    expect(JSON.stringify(sentBody(paypal!, 1))).toBe(stored); // same body AND same request id: PayPal sees an identical retry
    expect(repo.executions[0]?.editedDraft).toBeNull();
  });

  it("an accept_claim approval sends the fixed note and REFUND, with no draft", async () => {
    const { repo, paypal, deps } = setup(refundDispute());
    await refund(deps);
    expect(sentPath(paypal!)).toBe("/v1/customer/disputes/PP-D-1/accept-claim");
    expect(sentBody(paypal!)).toEqual({ note: expect.stringContaining("refund the buyer"), accept_claim_type: "REFUND" });
    expect(repo.executions[0]).toMatchObject({ originalDraft: null, editedDraft: null });
  });
});

describe("approve: refusals insert nothing and send nothing", () => {
  const expectUntouched = (s: ReturnType<typeof setup>) => {
    expect(s.repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 0 });
    expect(s.paypal!.request).not.toHaveBeenCalled();
  };

  it("not found / other session / malformed id", async () => {
    const s = setup();
    expect(await approve(s.deps, { sessionId: OTHER_SESSION })).toEqual({ kind: "not_found" });
    expect(await approve(s.deps, { disputeId: "nope" })).toEqual({ kind: "not_found" });
    expectUntouched(s);
  });

  it("not analysed yet", async () => {
    const s = setup(contestDispute({ analysisComputedAt: null, finalRecommendation: null }));
    expect(await approve(s.deps)).toEqual({ kind: "not_analyzed" });
    expectUntouched(s);
  });

  it("an action other than the recommended one", async () => {
    const contest = setup();
    expect(await refund(contest.deps)).toEqual({ kind: "wrong_action", expected: "submit_evidence" });
    expectUntouched(contest);
    const toRefund = setup(refundDispute());
    expect(await approve(toRefund.deps)).toEqual({ kind: "wrong_action", expected: "accept_claim" });
    expectUntouched(toRefund);
  });

  it("a dispute that is no longer open", async () => {
    for (const status of ["resolved_won", "resolved_refunded", "action_taken"] as const) {
      const s = setup(contestDispute({ status }));
      expect(await approve(s.deps), status).toEqual({ kind: "not_open" });
      expectUntouched(s);
    }
  });

  it("an item-not-received claim with no tracking on file, with the reason", async () => {
    const repo = createFakeDisputesRepo([makeRecord(contestDispute())], artefactRows(ORDER_ID, []));
    const paypal = scripted();
    const result = await approve({ repo, executor: { paypal, demoMode: false }, log: async () => undefined });
    expect(result).toMatchObject({ kind: "invalid", message: expect.stringContaining("tracking") });
    expect(repo.inserts.approvals).toBe(0);
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("no draft at all, and a draft over PayPal's limit", async () => {
    const empty = setup(contestDispute({ draftResponse: null }));
    expect(await approve(empty.deps)).toMatchObject({ kind: "invalid", message: expect.stringContaining("no draft") });
    expectUntouched(empty);

    const long = setup();
    expect(await approve(long.deps, { editedDraft: "x".repeat(2001) })).toMatchObject({ kind: "invalid", message: expect.stringContaining("2000") });
    expectUntouched(long);
  });

  it("an edited draft on a refund", async () => {
    const s = setup(refundDispute());
    expect(await refund(s.deps, { editedDraft: "Please refund with a note." })).toMatchObject({ kind: "invalid" });
    expectUntouched(s);
  });

  it("a database failure while storing the approval is rethrown, and nothing is sent", async () => {
    const s = setup();
    s.repo.insertApprovalWithExecution = async () => {
      throw new Error("connection lost");
    };
    await expect(approve(s.deps)).rejects.toThrow("connection lost");
    expect(s.paypal!.request).not.toHaveBeenCalled();
  });
});

describe("reject (REQ-DIS-05)", () => {
  it("records a rejection, creates no execution, sends nothing, and leaves the dispute open", async () => {
    const { repo, paypal, deps } = setup();
    const result = await rejectDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "demo-merchant", action: "submit_evidence" }, deps);

    expect(result).toMatchObject({ kind: "rejected", view: { status: "open" } });
    expect(repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 1 });
    expect(repo.approvals[0]).toMatchObject({ decision: "rejected", actionType: "submit_evidence", merchantUserId: "demo-merchant" });
    expect(repo.approvals[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.executions).toHaveLength(0);
    expect(paypal!.request).not.toHaveBeenCalled();
  });

  it("does not prevent a later approval, and an approved action can no longer be rejected", async () => {
    const { repo, deps } = setup();
    const reject = () => rejectDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "demo-merchant", action: "submit_evidence" }, deps);

    await reject();
    await reject(); // rejections are unconstrained
    expect(repo.approvals.filter((a) => a.decision === "rejected")).toHaveLength(2);

    expect((await approve(deps)).kind).toBe("executed");
    expect(await reject()).toEqual({ kind: "already_approved" });
  });

  it("is refused for the wrong action, an unanalysed or closed dispute, and another session's dispute", async () => {
    const s = setup();
    const req = { disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "demo-merchant", action: "submit_evidence" as const };
    expect(await rejectDispute({ ...req, action: "accept_claim" }, s.deps)).toEqual({ kind: "wrong_action", expected: "submit_evidence" });
    expect(await rejectDispute({ ...req, sessionId: OTHER_SESSION }, s.deps)).toEqual({ kind: "not_found" });
    expect(await rejectDispute(req, setup(contestDispute({ analysisComputedAt: null, finalRecommendation: null })).deps)).toEqual({ kind: "not_analyzed" });
    expect(await rejectDispute(req, setup(contestDispute({ status: "resolved_lost" })).deps)).toEqual({ kind: "not_open" });
    expect(s.repo.inserts.rejections).toBe(0);
  });
});

describe("resolveApprovalState and createApprovalWithExecution", () => {
  it("returns first / retry / already_executed from the stored rows", async () => {
    const { repo, deps } = setup(contestDispute(), scripted(new PayPalError("down"), ok));
    expect(await resolveApprovalState(repo, DISPUTE_ID, "submit_evidence")).toEqual({ kind: "first" });

    await approve(deps);
    expect(await resolveApprovalState(repo, DISPUTE_ID, "submit_evidence")).toMatchObject({ kind: "retry", approval: { id: repo.approvals[0]!.id }, execution: { executedAt: null } });

    await approve(deps);
    expect(await resolveApprovalState(repo, DISPUTE_ID, "submit_evidence")).toMatchObject({ kind: "already_executed", execution: { executedAt: NOW.toISOString() } });
  });

  it("keeps the two actions on one dispute apart, and ignores rejections", async () => {
    const { repo, deps } = setup();
    await rejectDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "submit_evidence" }, deps);
    expect(await resolveApprovalState(repo, DISPUTE_ID, "submit_evidence")).toEqual({ kind: "first" });
    await approve(deps);
    expect(await resolveApprovalState(repo, DISPUTE_ID, "accept_claim")).toEqual({ kind: "first" });
  });

  it("fails loudly, rather than creating a second approval, if an approval has no execution row", async () => {
    const { repo, deps } = setup();
    await approve(deps);
    repo.executions.length = 0; // damaged data
    await expect(resolveApprovalState(repo, DISPUTE_ID, "submit_evidence")).rejects.toThrow(/integrity/);
    await expect(approve(deps)).rejects.toThrow(/integrity/);
    expect(repo.inserts.approvals).toBe(1);
  });

  it("createApprovalWithExecution gives each new approval a fresh request id", async () => {
    const repo = createFakeDisputesRepo([makeRecord(contestDispute())]);
    const base = { actionType: "submit_evidence" as const, merchantUserId: "m", payloadHash: "h", approvedPayload: {}, originalDraft: null, editedDraft: null };
    const a = await createApprovalWithExecution(repo, { ...base, disputeId: "d1" });
    const b = await createApprovalWithExecution(repo, { ...base, disputeId: "d2" });
    expect(a.execution.paypalRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.execution.paypalRequestId).not.toBe(b.execution.paypalRequestId);
  });

  it("expectedAction maps the recommendation to the action", () => {
    expect(expectedAction("contest")).toBe("submit_evidence");
    expect(expectedAction("refund")).toBe("accept_claim");
    expect(expectedAction(null)).toBeNull();
  });
});

describe("approve: activity log", () => {
  it("logs the merchant's approval and the PayPal step against the dispute and session, with no payload text or request id", async () => {
    const { logs, deps } = setup();
    await approve(deps, { editedDraft: "Private edited wording." });

    expect(logs.map((l) => `${l.stepType}:${l.toolName}:${l.status}`)).toEqual(["merchant_action:approve_dispute_action:success", "paypal_api:submit_evidence:success"]);
    expect(logs.every((l) => l.refDisputeId === DISPUTE_ID && l.sessionId === SESSION)).toBe(true);
    const text = JSON.stringify(logs);
    for (const secret of ["Private edited wording.", "fresh-request-id", "9400111899223197428490"]) expect(text).not.toContain(secret);
  });

  it("logs a retry as such, and a rejection as a merchant action", async () => {
    const { logs, deps } = setup(contestDispute(), scripted(new PayPalError("down"), ok));
    await approve(deps);
    await approve(deps);
    expect(logs.map((l) => l.toolName)).toEqual(["approve_dispute_action", "submit_evidence", "retry_dispute_action", "submit_evidence"]);
    expect(logs.map((l) => l.status)).toEqual(["success", "error", "success", "success"]);

    const rejected = setup();
    await rejectDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "submit_evidence" }, rejected.deps);
    expect(rejected.logs).toEqual([expect.objectContaining({ stepType: "merchant_action", toolName: "reject_dispute_action", status: "success" })]);
  });

  it("a logger that throws changes nothing", async () => {
    const { repo, deps } = setup();
    const result = await approve({ ...deps, log: async () => { throw new Error("log table is down"); }, executor: { ...deps.executor, log: async () => { throw new Error("log table is down"); } } });
    expect(result.kind).toBe("executed");
    expect(repo.executions[0]?.executedAt).toBe(NOW.toISOString());
  });
});
