/**
 * The Drizzle repository against the real database: the approval unique index, the conditional
 * completion, and the refund outcome counted exactly once. Uses temporary demo disputes on a seeded
 * order, and restores the shared signal_weights counter afterwards.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedId } from "@/seed/ids";
import { ApprovalConflictError, type NewApprovalWithExecution } from "../types";

config({ path: ".env.local", quiet: true });

describe.skipIf(!process.env.DATABASE_URL)("disputes repo against the live database", () => {
  const created: string[] = [];
  let counterBefore = 0;

  const newDispute = async (): Promise<string> => {
    const { getSql } = await import("@/db/client");
    const id = randomUUID();
    created.push(id);
    const now = new Date().toISOString();
    await getSql()`
      INSERT INTO disputes (id, order_id, reason, disputed_amount_usd, deadline_at, status, session_id, is_seed, is_demo, created_at, updated_at, analysis_computed_at)
      VALUES (${id}, ${seedId("order", "SEED-A")}, 'item_not_received', 145, ${now}, 'open', 'repo-live-test', false, true, ${now}, ${now}, ${now})`;
    return id;
  };
  const input = (disputeId: string, actionType: "submit_evidence" | "accept_claim" = "submit_evidence"): NewApprovalWithExecution => ({
    disputeId,
    actionType,
    merchantUserId: "demo-merchant",
    payloadHash: "hash",
    approvedPayload: { evidences: [{ evidence_type: "DECLARATION", notes: "x" }] },
    originalDraft: "draft",
    editedDraft: null,
    paypalRequestId: randomUUID(),
  });
  const counter = async (): Promise<number> => {
    const { getSql } = await import("@/db/client");
    return (await getSql()<{ n: number }[]>`SELECT resolved_since_last_proposal AS n FROM signal_weights WHERE is_active = true`)[0]!.n;
  };

  beforeAll(async () => {
    counterBefore = await counter();
  });

  afterAll(async () => {
    const { closeDb, getSql } = await import("@/db/client");
    const sql = getSql();
    await sql`DELETE FROM action_executions WHERE dispute_id = ANY(${created}::uuid[])`;
    await sql`DELETE FROM approval_records WHERE dispute_id = ANY(${created}::uuid[])`;
    await sql`DELETE FROM dispute_outcomes WHERE dispute_id = ANY(${created}::uuid[])`;
    await sql`DELETE FROM disputes WHERE id = ANY(${created}::uuid[])`;
    await sql`UPDATE signal_weights SET resolved_since_last_proposal = ${counterBefore} WHERE is_active = true`;
    await closeDb();
  });

  it("a second APPROVED record for the same (dispute, action) is a real unique violation, recognised as ApprovalConflictError", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();

    const first = await repo.insertApprovalWithExecution(input(disputeId));
    expect(first.approval.decision).toBe("approved");
    expect(first.execution).toMatchObject({ approvalRecordId: first.approval.id, executedAt: null, isSimulated: false });

    await expect(repo.insertApprovalWithExecution(input(disputeId))).rejects.toBeInstanceOf(ApprovalConflictError);
    // The other action on the same dispute is a different key, so it is allowed.
    await expect(repo.insertApprovalWithExecution(input(disputeId, "accept_claim"))).resolves.toBeTruthy();

    const { getSql } = await import("@/db/client");
    const rows = await getSql()`SELECT count(*)::int AS n FROM approval_records WHERE dispute_id = ${disputeId} AND decision = 'approved'`;
    expect(rows[0]?.n).toBe(2);
  });

  it("five simultaneous first approvals: exactly one wins, four get the conflict, and exactly one execution row exists", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => repo.insertApprovalWithExecution(input(disputeId))));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(ApprovalConflictError);
    const { getSql } = await import("@/db/client");
    expect((await getSql()`SELECT count(*)::int AS n FROM action_executions WHERE dispute_id = ${disputeId}`)[0]?.n).toBe(1);
    expect((await getSql()`SELECT count(*)::int AS n FROM approval_records WHERE dispute_id = ${disputeId}`)[0]?.n).toBe(1); // the losers rolled back
  });

  it("rejections are unconstrained and do not block a later approval", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();
    const reject = { disputeId, actionType: "submit_evidence" as const, merchantUserId: "demo-merchant", payloadHash: "h" };

    await repo.insertRejection(reject);
    await repo.insertRejection(reject);
    expect(await repo.findApprovedApproval(disputeId, "submit_evidence")).toBeNull();
    await expect(repo.insertApprovalWithExecution(input(disputeId))).resolves.toBeTruthy();
    expect((await repo.findApprovedApproval(disputeId, "submit_evidence"))?.decision).toBe("approved");
  });

  it("submit_evidence completion: sets executed_at once, moves the dispute to action_taken, and is not applied twice", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();
    const { execution } = await repo.insertApprovalWithExecution(input(disputeId));
    const done = { executionId: execution.id, disputeId, actionType: "submit_evidence" as const, isSimulated: true, paypalResponse: { simulated: true }, executedAt: new Date().toISOString() };

    const first = await repo.completeExecution(done);
    const second = await repo.completeExecution({ ...done, executedAt: "2099-01-01T00:00:00.000Z" });

    expect(first).toMatchObject({ applied: true, outcomeRecorded: false });
    expect(first.execution).toMatchObject({ isSimulated: true, paypalResponse: { simulated: true } });
    expect(second).toEqual({ applied: false, execution: null, outcomeRecorded: false });
    const { getSql } = await import("@/db/client");
    expect((await getSql()`SELECT status FROM disputes WHERE id = ${disputeId}`)[0]?.status).toBe("action_taken");
    expect((await getSql()`SELECT executed_at FROM action_executions WHERE id = ${execution.id}`)[0]?.executed_at).toBe(done.executedAt); // the second call changed nothing
  });

  it("accept_claim completion: resolves the dispute as refunded and records ONE outcome and ONE counter increment", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();
    const { execution } = await repo.insertApprovalWithExecution(input(disputeId, "accept_claim"));
    const before = await counter();
    const done = {
      executionId: execution.id,
      disputeId,
      actionType: "accept_claim" as const,
      isSimulated: true,
      paypalResponse: { simulated: true },
      executedAt: new Date().toISOString(),
      refundOutcome: { riskScoreSnapshot: 10, verdictSnapshot: "ship" as const, winProbabilitySnapshot: 0.27, signalWeightsId: await repo.getActiveWeightsId() },
    };

    const first = await repo.completeExecution(done);
    const retry = await repo.completeExecution(done); // a retry after success must not count again

    expect(first).toMatchObject({ applied: true, outcomeRecorded: true });
    expect(retry).toMatchObject({ applied: false, outcomeRecorded: false });
    expect(await counter()).toBe(before + 1);
    const { getSql } = await import("@/db/client");
    expect(await getSql()`SELECT status, outcome, outcome_is_simulated FROM disputes WHERE id = ${disputeId}`).toMatchObject([{ status: "resolved_refunded", outcome: "refunded", outcome_is_simulated: true }]);
    const outcomes = await getSql()`SELECT outcome, risk_score_snapshot, verdict_snapshot, win_probability_snapshot, is_simulated FROM dispute_outcomes WHERE dispute_id = ${disputeId}`;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: "refunded", risk_score_snapshot: 10, verdict_snapshot: "ship", is_simulated: true });
    expect(Number(outcomes[0]?.win_probability_snapshot)).toBeCloseTo(0.27, 6);
  });

  it("if an outcome row already exists for the dispute, completion does not insert another or touch the counter", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();
    const { getSql } = await import("@/db/client");
    await getSql()`INSERT INTO dispute_outcomes (id, dispute_id, outcome, risk_score_snapshot, verdict_snapshot, win_probability_snapshot, is_simulated, created_at)
                   VALUES (${randomUUID()}, ${disputeId}, 'refunded', 1, 'ship', 0.5, false, ${new Date().toISOString()})`;
    const { execution } = await repo.insertApprovalWithExecution(input(disputeId, "accept_claim"));
    const before = await counter();

    const result = await repo.completeExecution({
      executionId: execution.id, disputeId, actionType: "accept_claim", isSimulated: false, paypalResponse: {}, executedAt: new Date().toISOString(),
      refundOutcome: { riskScoreSnapshot: 2, verdictSnapshot: "ship", winProbabilitySnapshot: 0.1, signalWeightsId: null },
    });

    expect(result).toMatchObject({ applied: true, outcomeRecorded: false });
    expect(await counter()).toBe(before);
    expect((await getSql()`SELECT count(*)::int AS n FROM dispute_outcomes WHERE dispute_id = ${disputeId}`)[0]?.n).toBe(1);
  });

  it("an accept_claim completion without a refund snapshot fails and changes nothing (the transaction rolls back)", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();
    const { execution } = await repo.insertApprovalWithExecution(input(disputeId, "accept_claim"));

    await expect(
      repo.completeExecution({ executionId: execution.id, disputeId, actionType: "accept_claim", isSimulated: false, paypalResponse: {}, executedAt: new Date().toISOString() }),
    ).rejects.toThrow(/refund outcome/);

    const { getSql } = await import("@/db/client");
    expect((await getSql()`SELECT executed_at FROM action_executions WHERE id = ${execution.id}`)[0]?.executed_at).toBeNull(); // not half-done
    expect((await getSql()`SELECT status FROM disputes WHERE id = ${disputeId}`)[0]?.status).toBe("open");
  });

  it("findApprovalById ignores malformed ids, and getExecutionByApproval finds the execution", async () => {
    const { createDrizzleDisputesRepo } = await import("../repo");
    const repo = createDrizzleDisputesRepo();
    const disputeId = await newDispute();
    const { approval, execution } = await repo.insertApprovalWithExecution(input(disputeId));
    expect(await repo.findApprovalById("not-a-uuid")).toBeNull();
    expect(await repo.findApprovalById(randomUUID())).toBeNull();
    expect((await repo.findApprovalById(approval.id))?.id).toBe(approval.id);
    expect((await repo.getExecutionByApproval(approval.id))?.id).toBe(execution.id);
  });
});
