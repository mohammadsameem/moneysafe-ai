import { describe, expect, it } from "vitest";
import type { ActivityMeta } from "@/lib/activity/logger";
import { approveDispute, rejectDispute } from "@/lib/disputes/approve";
import { loadDisputeDetail } from "@/lib/disputes/detail";
import { listDisputeViews } from "@/lib/disputes/read";
import { simulateOutcome } from "@/lib/disputes/simulate";
import { NOW, OTHER_SESSION, SESSION, analysed, createFakeSimulationRepo, makeRecord, type FakeSimulationRepo } from "@/lib/disputes/__tests__/fakes";
import { SEED_C, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import { SHARED_EXAMPLE_KEYS, buildDemoCopy, demoCopyId, sharedExampleId, startDemo } from "../copies";

const now = () => NOW;
const HOUR = 3_600_000;
const ORDER_C = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const ORDER_D = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const ORDER_E = "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0";
const SEED_C_ID = sharedExampleId("SEED-C");
const SEED_D_ID = sharedExampleId("SEED-D");
const SEED_E_ID = sharedExampleId("SEED-E");
const seedRow = { isSeed: true, isDemo: true, sessionId: null, deadlineAt: "2099-01-01T00:00:00Z" } as const;

function seeds() {
  return [
    makeRecord(analysed({ ...seedRow, id: SEED_C_ID, orderId: ORDER_C, deadlineOffsetHours: 72, disputedAmountUsd: 145 })),
    makeRecord(
      analysed({
        ...seedRow,
        id: SEED_D_ID,
        orderId: ORDER_D,
        deadlineOffsetHours: 48,
        disputedAmountUsd: 38,
        winProbability: 0.27,
        winLikelihoodLabel: "Weak",
        systemRecommendation: "refund",
        finalRecommendation: "refund",
        draftResponse: null,
      }),
    ),
    makeRecord(analysed({ ...seedRow, id: SEED_E_ID, orderId: ORDER_E, deadlineOffsetHours: 40, disputedAmountUsd: 210, winProbability: 0.44, winLikelihoodLabel: "Moderate", evidenceGaps: ["Delivery confirmation"] })),
  ];
}

function setup() {
  const records = seeds();
  const repo = createFakeSimulationRepo(records, records.map((r) => r.order), artefactRows(ORDER_C, SEED_C));
  const logs: ActivityMeta[] = [];
  return { repo, logs, deps: { repo, now, log: async (m: ActivityMeta) => void logs.push(m) } };
}

const dispute = (repo: FakeSimulationRepo, id: string) => repo.records.find((r) => r.dispute.id === id)?.dispute;
const approve = (repo: FakeSimulationRepo, sessionId: string, disputeId: string, action: "submit_evidence" | "accept_claim" = "submit_evidence") =>
  approveDispute({ disputeId, sessionId, merchantUserId: "m", action }, { repo, executor: { paypal: null, demoMode: false }, now });

describe("startDemo (M3-08)", () => {
  it("creates this session's own copies of SEED-C, SEED-D and SEED-E with the stored analysis and the seed offsets", async () => {
    const { repo, deps, logs } = setup();
    const result = await startDemo(SESSION, deps);

    expect(result).toMatchObject({ kind: "ok", created: 3 });
    if (result.kind !== "ok") return;
    expect(result.copies.map((c) => c.key)).toEqual([...SHARED_EXAMPLE_KEYS]);
    const offsets: Record<string, number> = { [SEED_C_ID]: 72, [SEED_D_ID]: 48, [SEED_E_ID]: 40 };
    for (const copy of result.copies) {
      expect(copy.disputeId).toBe(demoCopyId(SESSION, copy.seedDisputeId));
      const seed = dispute(repo, copy.seedDisputeId)!;
      const row = dispute(repo, copy.disputeId)!;
      expect(row).toMatchObject({
        isSeed: false,
        isDemo: true,
        sessionId: SESSION,
        status: "open",
        orderId: seed.orderId,
        reason: seed.reason,
        disputedAmountUsd: seed.disputedAmountUsd,
        winProbability: seed.winProbability,
        finalRecommendation: seed.finalRecommendation,
        draftResponse: seed.draftResponse,
        evidenceGaps: seed.evidenceGaps,
        analysisComputedAt: NOW.toISOString(),
        paypalDisputeId: null,
      });
      expect(row.deadlineAt).toBe(new Date(NOW.getTime() + offsets[copy.seedDisputeId]! * HOUR).toISOString());
    }
    // The seeds themselves are untouched.
    for (const id of [SEED_C_ID, SEED_D_ID, SEED_E_ID]) expect(dispute(repo, id)).toMatchObject({ isSeed: true, status: "open", sessionId: null });
    expect(logs.map((l) => [l.toolName, l.status])).toEqual([["start_demo", "simulated"]]);
  });

  it("the second Start demo click creates nothing new and returns the same copies", async () => {
    const { repo, deps, logs } = setup();
    const first = await startDemo(SESSION, deps);
    const second = await startDemo(SESSION, deps);
    expect(second).toMatchObject({ kind: "ok", created: 0 });
    if (first.kind !== "ok" || second.kind !== "ok") return;
    expect(second.copies.map((c) => c.disputeId)).toEqual(first.copies.map((c) => c.disputeId));
    expect(second.copies.every((c) => !c.created)).toBe(true);
    expect(repo.disputeInserts.value).toBe(3);
    expect(repo.records).toHaveLength(6);
    expect(logs).toHaveLength(1);
  });

  it("creates nothing when a seed is missing", async () => {
    const records = seeds().filter((r) => r.dispute.id !== SEED_E_ID);
    const repo = createFakeSimulationRepo(records, records.map((r) => r.order));
    expect(await startDemo(SESSION, { repo, now })).toEqual({ kind: "seed_missing", key: "SEED-E" });
    expect(repo.disputeInserts.value).toBe(0);
  });

  it("a copy never inherits a seed's resolution or PayPal link", () => {
    const seed = analysed({ ...seedRow, id: SEED_C_ID, status: "resolved_won", outcome: "won", outcomeIsSimulated: true, paypalDisputeId: "PP-1", deadlineOffsetHours: 72 });
    expect(buildDemoCopy(seed, SESSION, NOW)).toMatchObject({ status: "open", outcome: null, outcomeIsSimulated: false, paypalDisputeId: null, isSeed: false });
  });
});

describe("shared examples and per-session copies", () => {
  it("seeds cannot be approved or rejected directly", async () => {
    const { repo } = setup();
    expect(await approve(repo, SESSION, SEED_C_ID)).toEqual({ kind: "shared_example" });
    expect(await approve(repo, SESSION, SEED_D_ID, "accept_claim")).toEqual({ kind: "shared_example" });
    expect(await rejectDispute({ disputeId: SEED_E_ID, sessionId: SESSION, merchantUserId: "m", action: "submit_evidence" }, { repo, now })).toEqual({ kind: "shared_example" });
    expect(repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 0 });
    expect(repo.outcomes).toHaveLength(0);
  });

  it("two sessions approving their own SEED-C copies do not affect each other", async () => {
    const { repo, deps } = setup();
    await startDemo(SESSION, deps);
    await startDemo(OTHER_SESSION, deps);
    const mine = demoCopyId(SESSION, SEED_C_ID);
    const theirs = demoCopyId(OTHER_SESSION, SEED_C_ID);
    expect(mine).not.toBe(theirs);

    // Session A approves its copy.
    expect(await approve(repo, SESSION, mine)).toMatchObject({ kind: "executed", simulated: true });
    expect(dispute(repo, mine)?.status).toBe("action_taken");
    expect(dispute(repo, theirs)?.status).toBe("open");
    expect(dispute(repo, SEED_C_ID)?.status).toBe("open");
    const detailDeps = { repo, paypal: null, demoMode: false, now };
    expect((await loadDisputeDetail(theirs, OTHER_SESSION, detailDeps))?.panel).toMatchObject({ mode: "decide", action: "submit_evidence" });

    // Neither session can act on the other's copy.
    expect(await approve(repo, OTHER_SESSION, mine)).toEqual({ kind: "not_found" });
    expect(await loadDisputeDetail(mine, OTHER_SESSION, detailDeps)).toBeNull();

    // Session B approves its own copy: a separate approval and execution, not "already executed".
    expect(await approve(repo, OTHER_SESSION, theirs)).toMatchObject({ kind: "executed", retried: false });
    expect(repo.approvals.map((a) => a.disputeId).sort()).toEqual([mine, theirs].sort());

    // A records Won; B's copy stays action_taken and can still be resolved independently.
    expect((await simulateOutcome({ disputeId: mine, sessionId: SESSION, outcome: "won" }, { repo, demoMode: false, now })).kind).toBe("recorded");
    expect(dispute(repo, theirs)?.status).toBe("action_taken");
    expect((await simulateOutcome({ disputeId: theirs, sessionId: OTHER_SESSION, outcome: "lost" }, { repo, demoMode: false, now })).kind).toBe("recorded");
    expect([dispute(repo, mine)?.outcome, dispute(repo, theirs)?.outcome]).toEqual(["won", "lost"]);
    expect(repo.counter.value).toBe(2);
  });

  it("the inbox shows a session its copies instead of the seeds; a session without copies sees the shared examples", async () => {
    const { repo, deps } = setup();
    await startDemo(SESSION, deps);
    const readDeps = { repo, paypal: null, demoMode: false, now };

    const mine = await listDisputeViews(SESSION, "open", readDeps);
    expect(mine.map((v) => v.id).sort()).toEqual([SEED_C_ID, SEED_D_ID, SEED_E_ID].map((s) => demoCopyId(SESSION, s)).sort());
    expect(mine.every((v) => v.isDemo && !v.isSharedExample)).toBe(true);

    const theirs = await listDisputeViews(OTHER_SESSION, "open", readDeps);
    expect(theirs.map((v) => v.id).sort()).toEqual([SEED_C_ID, SEED_D_ID, SEED_E_ID].sort());
    expect(theirs.every((v) => v.isSharedExample)).toBe(true);

    // Refunding my SEED-D copy moves it to my Resolved tab; the seed stays hidden from me and open for others.
    expect((await approve(repo, SESSION, demoCopyId(SESSION, SEED_D_ID), "accept_claim")).kind).toBe("executed");
    expect((await listDisputeViews(SESSION, "resolved", readDeps)).map((v) => v.id)).toEqual([demoCopyId(SESSION, SEED_D_ID)]);
    expect((await listDisputeViews(SESSION, "open", readDeps)).map((v) => v.id)).not.toContain(SEED_D_ID);
    expect((await listDisputeViews(OTHER_SESSION, "open", readDeps)).map((v) => v.id)).toContain(SEED_D_ID);
  });

  it("an open seed's page offers Start demo (shared_example) and points at this session's copy", async () => {
    const { repo } = setup();
    const detail = await loadDisputeDetail(SEED_C_ID, SESSION, { repo, paypal: null, demoMode: false, now });
    expect(detail?.panel).toEqual({ mode: "shared_example", copyId: demoCopyId(SESSION, SEED_C_ID) });
    expect(detail?.view.isSharedExample).toBe(true);
  });
});
