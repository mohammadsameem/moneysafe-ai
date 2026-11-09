import { describe, expect, it, vi } from "vitest";
import type { ActivityMeta } from "@/lib/activity/logger";
import { createFakePayPal } from "@/lib/orders/__tests__/fakes";
import { ApprovalRequiredError, PayPalError } from "@/lib/paypal";
import { executeApproved, refundSnapshot, type ExecuteContext, type ExecutorDeps } from "../executor";
import type { DisputeActionType } from "../types";
import { DISPUTE_ID, NOW, SESSION, analysed, createFakeDisputesRepo, makeRecord } from "./fakes";

const EVIDENCE_BODY = { evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "USPS", tracking_number: "9400" }] }, notes: "Delivered." }] };
const ACCEPT_BODY = { note: "The merchant accepts the claim and will refund the buyer in full.", accept_claim_type: "REFUND" };
const EVIDENCE_PATH = "POST /v1/customer/disputes/PP-D-1/provide-evidence";
const ACCEPT_PATH = "POST /v1/customer/disputes/PP-D-1/accept-claim";

type DisputeOver = Parameters<typeof analysed>[0];

/** A repo holding one dispute with an approved approval and its unexecuted execution, ready to execute. */
async function prepare(action: DisputeActionType, disputeOver: DisputeOver = {}, payload: Record<string, unknown> | null = null) {
  const record = makeRecord(analysed({ isSeed: false, isDemo: false, paypalDisputeId: "PP-D-1", ...disputeOver }));
  const repo = createFakeDisputesRepo([record]);
  const { approval, execution } = await repo.insertApprovalWithExecution({
    disputeId: DISPUTE_ID,
    actionType: action,
    merchantUserId: "demo-merchant",
    payloadHash: "hash",
    approvedPayload: payload ?? (action === "submit_evidence" ? EVIDENCE_BODY : ACCEPT_BODY),
    originalDraft: "draft",
    editedDraft: null,
    paypalRequestId: "stored-request-id",
  });
  repo.inserts.approvals = 0; // count only what the executor itself inserts
  repo.inserts.executions = 0;
  const ctx: ExecuteContext = { dispute: record.dispute, order: record.order, approval, execution, sessionId: SESSION };
  return { repo, ctx };
}

function deps(repo: ExecutorDeps["repo"], over: Partial<ExecutorDeps> = {}): ExecutorDeps & { logs: ActivityMeta[] } {
  const logs: ActivityMeta[] = [];
  return { repo, paypal: null, demoMode: false, now: () => NOW, log: async (m) => void logs.push(m), ...over, logs };
}

const requestIdOf = (paypal: ReturnType<typeof createFakePayPal>, n = 0) => (paypal.request.mock.calls[n]?.[1] as { requestId?: string }).requestId;
const bodyOf = (paypal: ReturnType<typeof createFakePayPal>, n = 0) => (paypal.request.mock.calls[n]?.[1] as { body?: unknown }).body;

describe("executeApproved: simulation (DEMO_MODE, seeded or demo dispute)", () => {
  it.each([
    ["a seeded dispute", { isSeed: true, isDemo: false }, false],
    ["a demo dispute", { isSeed: false, isDemo: true }, false],
    ["DEMO_MODE on a live-linked dispute", { isSeed: false, isDemo: false }, true],
  ])("%s: no PayPal call, marked simulated, executed", async (_name, over, demoMode) => {
    const { repo, ctx } = await prepare("submit_evidence", over);
    const paypal = createFakePayPal({});
    const d = deps(repo, { paypal, demoMode });

    const result = await executeApproved(ctx, d);

    expect(result.kind).toBe("executed");
    expect(paypal.request).not.toHaveBeenCalled();
    expect(repo.executions[0]).toMatchObject({ isSimulated: true, executedAt: NOW.toISOString(), paypalResponse: { simulated: true } });
    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]).toMatchObject({ stepType: "paypal_api", toolName: "submit_evidence", status: "simulated", refDisputeId: DISPUTE_ID });
  });

  it("simulates even with no PayPal credentials at all", async () => {
    const { repo, ctx } = await prepare("submit_evidence", { isSeed: true });
    expect((await executeApproved(ctx, deps(repo, { paypal: null }))).kind).toBe("executed");
  });
});

describe("executeApproved: live", () => {
  it("submit_evidence: sends the STORED payload to provide-evidence with the STORED PayPal-Request-Id", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    const paypal = createFakePayPal({ [EVIDENCE_PATH]: { links: [] } });

    const result = await executeApproved(ctx, deps(repo, { paypal }));

    expect(result).toMatchObject({ kind: "executed", simulated: false, outcomeRecorded: false });
    expect(paypal.request).toHaveBeenCalledTimes(1);
    expect(requestIdOf(paypal)).toBe("stored-request-id");
    expect(bodyOf(paypal)).toEqual(EVIDENCE_BODY);
    expect(repo.executions[0]).toMatchObject({ isSimulated: false, executedAt: NOW.toISOString(), paypalResponse: { links: [] } });
    expect(repo.records[0]?.dispute.status).toBe("action_taken");
    expect(repo.outcomes).toHaveLength(0);
  });

  it("accept_claim: sends { note, accept_claim_type: REFUND } to accept-claim and records the refund outcome once", async () => {
    const { repo, ctx } = await prepare("accept_claim", { finalRecommendation: "refund" });
    const paypal = createFakePayPal({ [ACCEPT_PATH]: {} });
    const onOutcomeRecorded = vi.fn(async () => undefined);

    const result = await executeApproved(ctx, deps(repo, { paypal, onOutcomeRecorded }));

    expect(result).toMatchObject({ kind: "executed", simulated: false, outcomeRecorded: true });
    expect(requestIdOf(paypal)).toBe("stored-request-id");
    expect(bodyOf(paypal)).toEqual(ACCEPT_BODY);
    expect(repo.records[0]?.dispute).toMatchObject({ status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: false });
    expect(repo.outcomes).toHaveLength(1);
    expect(repo.counter.value).toBe(1);
    expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
    // The hook gets the counter value THIS outcome's bump produced (the learning loop keys on it).
    expect(onOutcomeRecorded).toHaveBeenCalledWith({ sessionId: SESSION, disputeId: DISPUTE_ID, counterAfter: 1 });
  });

  it("the hook is told the counter after each outcome: 1, 2, 3 ... (never the same value twice)", async () => {
    const seen: (number | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const record = makeRecord(analysed({ isSeed: false, isDemo: true, id: `dddddddd-dddd-4ddd-8ddd-00000000000${i}`, finalRecommendation: "refund" }));
      const repo = createFakeDisputesRepo([record]);
      repo.counter.value = i; // the shared counter already holds the previous outcomes
      const { approval, execution } = await repo.insertApprovalWithExecution({
        disputeId: record.dispute.id,
        actionType: "accept_claim",
        merchantUserId: "m",
        payloadHash: "h",
        approvedPayload: ACCEPT_BODY,
        originalDraft: null,
        editedDraft: null,
        paypalRequestId: "r",
      });
      await executeApproved(
        { dispute: record.dispute, order: record.order, approval, execution, sessionId: SESSION },
        deps(repo, { onOutcomeRecorded: async (e) => void seen.push(e.counterAfter) }),
      );
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("a PayPal failure marks nothing done and returns a retryable error with PayPal's safe message", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    const paypal = createFakePayPal({ [EVIDENCE_PATH]: new PayPalError("PayPal POST provide-evidence failed with HTTP 500 (debug_id d1)", 500) });
    const d = deps(repo, { paypal });

    const result = await executeApproved(ctx, d);

    expect(result).toMatchObject({ kind: "failed", message: "PayPal POST provide-evidence failed with HTTP 500 (debug_id d1)" });
    expect(repo.executions[0]?.executedAt).toBeNull();
    expect(repo.records[0]?.dispute.status).toBe("open");
    expect(d.logs[0]).toMatchObject({ status: "error", toolName: "submit_evidence" });
  });

  it("retry after a failure reuses the same PayPal-Request-Id and then succeeds", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    const paypal = createFakePayPal({ [EVIDENCE_PATH]: new PayPalError("PayPal could not be reached") });
    expect((await executeApproved(ctx, deps(repo, { paypal }))).kind).toBe("failed");

    // PayPal is back; the same stored execution row is executed again.
    const healthy = createFakePayPal({ [EVIDENCE_PATH]: {} });
    const result = await executeApproved({ ...ctx, execution: repo.executions[0]! }, deps(repo, { paypal: healthy }));

    expect(result.kind).toBe("executed");
    expect(requestIdOf(paypal)).toBe("stored-request-id");
    expect(requestIdOf(healthy)).toBe("stored-request-id");
    expect(repo.executions).toHaveLength(1);
    expect(repo.executions[0]?.executedAt).toBe(NOW.toISOString());
  });

  it("a live action with no PayPal credentials, or on a dispute with no PayPal id, fails without marking anything done", async () => {
    const noCreds = await prepare("submit_evidence");
    expect(await executeApproved(noCreds.ctx, deps(noCreds.repo, { paypal: null }))).toMatchObject({ kind: "failed", message: expect.stringContaining("credentials") });
    expect(noCreds.repo.executions[0]?.executedAt).toBeNull();

    const noId = await prepare("submit_evidence", { paypalDisputeId: null });
    const paypal = createFakePayPal({});
    expect(await executeApproved(noId.ctx, deps(noId.repo, { paypal }))).toMatchObject({ kind: "failed", message: expect.stringContaining("not linked") });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("does not hide a bug as a retryable failure: a non-PayPal error is rethrown", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    const paypal = createFakePayPal({ [EVIDENCE_PATH]: new TypeError("bug") });
    await expect(executeApproved(ctx, deps(repo, { paypal }))).rejects.toThrow("bug");
    expect(repo.executions[0]?.executedAt).toBeNull();
  });

  it("refuses a stored payload that is not a valid PayPal body, sending nothing", async () => {
    for (const [action, payload] of [["submit_evidence", { evidences: [] }], ["submit_evidence", { nonsense: true }], ["accept_claim", { note: "x", accept_claim_type: "PARTIAL" }]] as const) {
      const { repo, ctx } = await prepare(action, {}, payload);
      const paypal = createFakePayPal({});
      expect(await executeApproved(ctx, deps(repo, { paypal }))).toMatchObject({ kind: "failed", message: expect.stringContaining("not valid") });
      expect(paypal.request).not.toHaveBeenCalled();
      expect(repo.executions[0]?.executedAt).toBeNull();
    }
  });
});

describe("executeApproved: the approval gate (REQ-NFR-03)", () => {
  it("no approval record in the store -> ApprovalRequiredError, no PayPal call, nothing marked done", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    repo.approvals.length = 0; // the approval does not exist
    const paypal = createFakePayPal({});

    await expect(executeApproved(ctx, deps(repo, { paypal }))).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(paypal.request).not.toHaveBeenCalled();
    expect(repo.executions[0]?.executedAt).toBeNull();
  });

  it("the same applies to a simulated action: no approval, nothing simulated", async () => {
    const { repo, ctx } = await prepare("accept_claim", { isSeed: true });
    repo.approvals.length = 0;
    await expect(executeApproved(ctx, deps(repo))).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(repo.executions[0]?.executedAt).toBeNull();
    expect(repo.outcomes).toHaveLength(0);
    expect(repo.counter.value).toBe(0);
  });

  it("a REJECTED record never authorises a write", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    const approval = repo.approvals[0]!;
    repo.approvals[0] = { ...approval, decision: "rejected" };
    const paypal = createFakePayPal({});
    await expect(executeApproved(ctx, deps(repo, { paypal }))).rejects.toMatchObject({ reason: "not_approved" });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("an approval for the OTHER action cannot authorise this one", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    repo.approvals[0] = { ...repo.approvals[0]!, actionType: "accept_claim" };
    const paypal = createFakePayPal({});
    await expect(executeApproved(ctx, deps(repo, { paypal }))).rejects.toMatchObject({ reason: "action_mismatch" });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("an approval for ANOTHER dispute cannot authorise this one", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    repo.approvals[0] = { ...repo.approvals[0]!, disputeId: "some-other-dispute" };
    await expect(executeApproved(ctx, deps(repo, { paypal: createFakePayPal({}) }))).rejects.toMatchObject({ reason: "dispute_mismatch" });
  });
});

describe("executeApproved: idempotency and concurrency", () => {
  it("an execution that is already done is reported and sends nothing", async () => {
    const { repo, ctx } = await prepare("submit_evidence", { isSeed: true });
    await executeApproved(ctx, deps(repo));
    const paypal = createFakePayPal({});

    const again = await executeApproved({ ...ctx, execution: repo.executions[0]! }, deps(repo, { paypal }));

    expect(again.kind).toBe("already_executed");
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("two simultaneous executions of a refund record the outcome once and count it once", async () => {
    const { repo, ctx } = await prepare("accept_claim", { isSeed: true, finalRecommendation: "refund" });
    const onOutcomeRecorded = vi.fn(async () => undefined);

    const [a, b] = await Promise.all([executeApproved(ctx, deps(repo, { onOutcomeRecorded })), executeApproved(ctx, deps(repo, { onOutcomeRecorded }))]);

    expect([a.kind, b.kind].sort()).toEqual(["already_executed", "executed"]);
    expect(repo.outcomes).toHaveLength(1);
    expect(repo.counter.value).toBe(1);
    expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
  });

  it("a learning-loop hook that throws does not change the result", async () => {
    const { repo, ctx } = await prepare("accept_claim", { isSeed: true });
    const result = await executeApproved(ctx, deps(repo, { onOutcomeRecorded: async () => { throw new Error("loop down"); } }));
    expect(result).toMatchObject({ kind: "executed", outcomeRecorded: true });
  });

  it("a logger that throws does not change the result", async () => {
    const { repo, ctx } = await prepare("submit_evidence", { isSeed: true });
    const result = await executeApproved(ctx, { ...deps(repo), log: async () => { throw new Error("log table is down"); } });
    expect(result.kind).toBe("executed");
  });
});

describe("executeApproved: consequences of a simulated refund", () => {
  it("accept_claim on a seeded dispute resolves it as refunded, marks the outcome simulated and snapshots the order", async () => {
    const { repo, ctx } = await prepare("accept_claim", { isSeed: true, finalRecommendation: "refund", winProbability: 0.27, riskScoreSnapshot: 12 });
    const result = await executeApproved(ctx, deps(repo));

    expect(result).toMatchObject({ kind: "executed", simulated: true, outcomeRecorded: true });
    expect(repo.records[0]?.dispute).toMatchObject({ status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: true });
    expect(repo.outcomes[0]).toMatchObject({ outcome: "refunded", isSimulated: true, riskScoreSnapshot: 12, verdictSnapshot: "ship", winProbabilitySnapshot: 0.27, signalWeightsId: "active-weights-id" });
    expect(repo.counter.value).toBe(1);
  });

  it("submit_evidence leaves the dispute 'action_taken' (not resolved) and records no outcome", async () => {
    const { repo, ctx } = await prepare("submit_evidence", { isSeed: true });
    await executeApproved(ctx, deps(repo));
    expect(repo.records[0]?.dispute).toMatchObject({ status: "action_taken", outcome: null });
    expect(repo.outcomes).toHaveLength(0);
    expect(repo.counter.value).toBe(0);
  });
});

describe("refundSnapshot", () => {
  const record = makeRecord(analysed({ riskScoreSnapshot: 55, winProbability: 0.44, baseWinProbability: 0.4 }), { riskScore: 20, verdict: "verify", weightsId: "order-weights" });

  it("prefers the dispute's own snapshot and the weights the order was scored with", () => {
    expect(refundSnapshot(record.dispute, record.order, "active")).toEqual({ riskScoreSnapshot: 55, verdictSnapshot: "verify", winProbabilitySnapshot: 0.44, signalWeightsId: "order-weights" });
  });

  it("falls back step by step: order score, base probability, active weights, and 'ship' for an unscored order", () => {
    const bare = makeRecord(analysed({ riskScoreSnapshot: null, winProbability: null, baseWinProbability: 0.4 }), { riskScore: 20, verdict: null, weightsId: null });
    expect(refundSnapshot(bare.dispute, bare.order, "active")).toEqual({ riskScoreSnapshot: 20, verdictSnapshot: "ship", winProbabilitySnapshot: 0.4, signalWeightsId: "active" });
    const empty = makeRecord(analysed({ riskScoreSnapshot: null, winProbability: null, baseWinProbability: null }), { riskScore: null, verdict: null, weightsId: null });
    expect(refundSnapshot(empty.dispute, empty.order, null)).toEqual({ riskScoreSnapshot: 0, verdictSnapshot: "ship", winProbabilitySnapshot: 0, signalWeightsId: null });
  });
});

describe("executeApproved: logs", () => {
  it("log one paypal_api row, with the action as the tool name and no request id or payload", async () => {
    const { repo, ctx } = await prepare("submit_evidence");
    const paypal = createFakePayPal({ [EVIDENCE_PATH]: {} });
    const d = deps(repo, { paypal });
    await executeApproved(ctx, d);
    expect(d.logs).toHaveLength(1);
    const text = JSON.stringify(d.logs);
    expect(text).not.toContain("stored-request-id");
    expect(text).not.toContain("Delivered.");
    expect(d.logs[0]).toMatchObject({ sessionId: SESSION, refDisputeId: DISPUTE_ID, status: "success" });
  });
});
