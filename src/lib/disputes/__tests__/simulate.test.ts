import { describe, expect, it } from "vitest";
import type { ActivityMeta } from "@/lib/activity/logger";
import { SEED_C, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import { makeOrder } from "@/lib/orders/__tests__/fakes";
import { approveDispute } from "../approve";
import { loadDisputeDetail } from "../detail";
import { SIMULATED_DEADLINE_HOURS, simulateDispute, simulateOutcome, simulatedDisputeId } from "../simulate";
import { buildTimeline } from "../timeline";
import { NOW, ORDER_ID, OTHER_SESSION, SESSION, analysed, createFakeSimulationRepo, makeRecord, type FakeSimulationRepo } from "./fakes";

const now = () => NOW;
const shippedDemoOrder = (overrides: Parameters<typeof makeOrder>[0] = {}) =>
  makeOrder({ id: ORDER_ID, status: "shipped", isDemo: true, isSeed: false, sessionId: SESSION, amountUsd: 120, riskScore: 10, verdict: "ship", ...overrides });

function deps(repo: FakeSimulationRepo, extra: { demoMode?: boolean; onOutcomeRecorded?: () => Promise<void> } = {}) {
  const logs: ActivityMeta[] = [];
  return {
    logs,
    deps: { repo, demoMode: extra.demoMode ?? false, now, log: async (m: ActivityMeta) => void logs.push(m), onOutcomeRecorded: extra.onOutcomeRecorded },
  };
}

const approveDeps = (repo: FakeSimulationRepo) => ({ repo, executor: { paypal: null, demoMode: true }, now });

describe("simulateDispute", () => {
  it("opens an is_demo dispute for this session with a concrete 72 h deadline and no analysis", async () => {
    const repo = createFakeSimulationRepo([], [shippedDemoOrder()]);
    const { deps: d, logs } = deps(repo);
    const result = await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, d);

    expect(result).toEqual({ kind: "created", disputeId: simulatedDisputeId(SESSION, ORDER_ID) });
    const created = repo.records[0]!.dispute;
    expect(created).toMatchObject({ isDemo: true, isSeed: false, sessionId: SESSION, status: "open", deadlineOffsetHours: SIMULATED_DEADLINE_HOURS, disputedAmountUsd: 120, analysisComputedAt: null, paypalDisputeId: null });
    expect(created.deadlineAt).toBe(new Date(NOW.getTime() + 72 * 3_600_000).toISOString());
    expect(logs.map((l) => [l.toolName, l.status])).toEqual([["simulate_dispute", "simulated"]]);
  });

  it("is idempotent per session and order: a second call creates nothing and returns the same id", async () => {
    const repo = createFakeSimulationRepo([], [shippedDemoOrder()]);
    const first = await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, deps(repo).deps);
    const second = await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, deps(repo).deps);
    expect(second).toEqual({ kind: "exists", disputeId: first.kind === "created" ? first.disputeId : "" });
    expect(repo.disputeInserts.value).toBe(1);
  });

  it("two sessions simulating on the same seeded order get separate disputes", async () => {
    const seedOrder = shippedDemoOrder({ isSeed: true, isDemo: true, sessionId: null });
    const repo = createFakeSimulationRepo([], [seedOrder]);
    const a = await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, deps(repo).deps);
    const b = await simulateDispute({ orderId: ORDER_ID, sessionId: OTHER_SESSION }, deps(repo).deps);
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("created");
    expect(repo.records.map((r) => r.dispute.sessionId).sort()).toEqual([SESSION, OTHER_SESSION].sort());
  });

  it("refuses orders that are not shipped, not visible, or real outside Demo Mode", async () => {
    const captured = createFakeSimulationRepo([], [shippedDemoOrder({ status: "captured" })]);
    expect(await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, deps(captured).deps)).toEqual({ kind: "not_shipped" });

    const others = createFakeSimulationRepo([], [shippedDemoOrder({ sessionId: OTHER_SESSION })]);
    expect(await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, deps(others).deps)).toEqual({ kind: "order_not_found" });

    const real = createFakeSimulationRepo([], [shippedDemoOrder({ isDemo: false })]);
    expect(await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, deps(real).deps)).toEqual({ kind: "not_allowed" });
    expect((await simulateDispute({ orderId: ORDER_ID, sessionId: SESSION }, deps(real, { demoMode: true }).deps)).kind).toBe("created");
    expect(captured.disputeInserts.value + others.disputeInserts.value).toBe(0);
  });
});

describe("simulateOutcome", () => {
  async function contested(outcomeHook?: () => Promise<void>) {
    const record = makeRecord(analysed({ isDemo: true, isSeed: false, sessionId: SESSION }));
    const repo = createFakeSimulationRepo([record], [record.order], artefactRows(ORDER_ID, SEED_C));
    const approved = await approveDispute({ disputeId: record.dispute.id, sessionId: SESSION, merchantUserId: "m", action: "submit_evidence" }, approveDeps(repo));
    expect(approved.kind).toBe("executed");
    expect(repo.records[0]!.dispute.status).toBe("action_taken");
    return { repo, id: record.dispute.id, ...deps(repo, { onOutcomeRecorded: outcomeHook }) };
  }

  it("records Won as a simulated outcome in one step: status, outcome row, counter, hook", async () => {
    let hookCalls = 0;
    const { repo, id, deps: d, logs } = await contested(async () => void (hookCalls += 1));
    const result = await simulateOutcome({ disputeId: id, sessionId: SESSION, outcome: "won" }, d);

    expect(result.kind).toBe("recorded");
    expect(repo.records[0]!.dispute).toMatchObject({ status: "resolved_won", outcome: "won", outcomeIsSimulated: true });
    expect(repo.outcomes).toEqual([expect.objectContaining({ disputeId: id, outcome: "won", isSimulated: true, riskScoreSnapshot: 0, winProbabilitySnapshot: 0.95 })]);
    expect(repo.counter.value).toBe(1);
    expect(hookCalls).toBe(1);
    expect(logs.map((l) => [l.toolName, l.status])).toEqual([["simulate_outcome", "simulated"]]);
  });

  it("records Lost, and a second call is already_resolved and counts nothing", async () => {
    const { repo, id, deps: d } = await contested();
    expect((await simulateOutcome({ disputeId: id, sessionId: SESSION, outcome: "lost" }, d)).kind).toBe("recorded");
    expect(repo.records[0]!.dispute.status).toBe("resolved_lost");
    const again = await simulateOutcome({ disputeId: id, sessionId: SESSION, outcome: "won" }, d);
    expect(again.kind).toBe("already_resolved");
    expect(repo.records[0]!.dispute.outcome).toBe("lost");
    expect(repo.outcomes).toHaveLength(1);
    expect(repo.counter.value).toBe(1);
  });

  it("is refused before evidence was submitted", async () => {
    const record = makeRecord(analysed({ isDemo: true, sessionId: SESSION }));
    const repo = createFakeSimulationRepo([record], [record.order]);
    expect(await simulateOutcome({ disputeId: record.dispute.id, sessionId: SESSION, outcome: "won" }, deps(repo).deps)).toEqual({ kind: "not_contested" });
    expect(repo.outcomes).toHaveLength(0);
  });

  it("is refused on the refund path (its outcome was recorded automatically)", async () => {
    const record = makeRecord(analysed({ isDemo: true, sessionId: SESSION, systemRecommendation: "refund", finalRecommendation: "refund", winProbability: 0.27, winLikelihoodLabel: "Weak" }));
    const repo = createFakeSimulationRepo([record], [record.order]);
    expect((await approveDispute({ disputeId: record.dispute.id, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" }, approveDeps(repo))).kind).toBe("executed");
    expect(repo.counter.value).toBe(1);
    expect(await simulateOutcome({ disputeId: record.dispute.id, sessionId: SESSION, outcome: "won" }, deps(repo).deps)).toEqual({ kind: "refund_path" });
    expect(repo.outcomes.map((o) => o.outcome)).toEqual(["refunded"]);
    expect(repo.counter.value).toBe(1);
  });

  it("is refused on seeded, real and other sessions' disputes", async () => {
    const seed = makeRecord(analysed({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", isSeed: true, isDemo: true, sessionId: null, status: "action_taken" }));
    const real = makeRecord(analysed({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", isDemo: false, sessionId: SESSION, status: "action_taken" }));
    const other = makeRecord(analysed({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", isDemo: true, sessionId: OTHER_SESSION, status: "action_taken" }));
    const repo = createFakeSimulationRepo([seed, real, other]);
    const d = deps(repo).deps;
    expect(await simulateOutcome({ disputeId: seed.dispute.id, sessionId: SESSION, outcome: "won" }, d)).toEqual({ kind: "not_demo" });
    expect(await simulateOutcome({ disputeId: real.dispute.id, sessionId: SESSION, outcome: "won" }, d)).toEqual({ kind: "not_demo" });
    expect(await simulateOutcome({ disputeId: other.dispute.id, sessionId: SESSION, outcome: "won" }, d)).toEqual({ kind: "not_found" });
    expect(repo.outcomes).toHaveLength(0);
  });

  it("the detail page offers the control only after submit_evidence, and the timeline shows the simulated outcome", async () => {
    const { repo, id, deps: d } = await contested();
    const detailDeps = { repo, paypal: null, demoMode: true, now };
    const before = await loadDisputeDetail(id, SESSION, detailDeps);
    expect(before?.panel.mode).toBe("done");
    expect(before?.canSimulateOutcome).toBe(true);

    await simulateOutcome({ disputeId: id, sessionId: SESSION, outcome: "won" }, d);
    const after = await loadDisputeDetail(id, SESSION, detailDeps);
    expect(after?.canSimulateOutcome).toBe(false);
    const action = buildTimeline(after!).find((s) => s.key === "action");
    expect(action?.detail).toContain("Outcome: Won (simulated outcome).");
    expect(action?.simulated).toBe(true);
  });

  it("never offers the control after a refund", async () => {
    const record = makeRecord(analysed({ isDemo: true, sessionId: SESSION, systemRecommendation: "refund", finalRecommendation: "refund" }));
    const repo = createFakeSimulationRepo([record], [record.order]);
    await approveDispute({ disputeId: record.dispute.id, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" }, approveDeps(repo));
    const detail = await loadDisputeDetail(record.dispute.id, SESSION, { repo, paypal: null, demoMode: true, now });
    expect(detail?.panel).toMatchObject({ mode: "done", action: "accept_claim" });
    expect(detail?.canSimulateOutcome).toBe(false);
  });
});
