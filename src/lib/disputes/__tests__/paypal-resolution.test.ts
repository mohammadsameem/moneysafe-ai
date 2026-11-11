import { describe, expect, it } from "vitest";
import { createFakePayPal } from "@/lib/orders/__tests__/fakes";
import { SEED_C, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import { PayPalError } from "@/lib/paypal";
import { approveDispute } from "../approve";
import { loadDisputeDetail } from "../detail";
import { createLiveGate } from "../live-gate";
import { describeResolution, isClosedOnPayPal, mapPayPalResolution } from "../paypal-resolution";
import type { DisputeResolutionRepo, DisputeRecord } from "../types";
import { DISPUTE_ID, NOW, ORDER_ID, SESSION, analysed, createFakeDisputesRepo, makeRecord } from "./fakes";

const PP = "PP-R-PIN-10197984";
const GET = `GET /v1/customer/disputes/${PP}`;

/** What the real sandbox returned once the seller's refund had settled the dispute. */
const closed = (over: Record<string, unknown> = {}) => ({
  dispute_id: PP,
  status: "RESOLVED",
  dispute_state: "RESOLVED",
  dispute_life_cycle_stage: "INQUIRY",
  dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR", outcome_reason: "SELLER_ISSUED_REFUND" },
  ...over,
});
const open = () => ({
  dispute_id: PP,
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_state: "REQUIRED_ACTION",
  dispute_life_cycle_stage: "INQUIRY",
  allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] } },
});

const real = (over: Parameters<typeof analysed>[0] = {}) =>
  analysed({ isDemo: false, isSeed: false, paypalDisputeId: PP, sessionId: SESSION, systemRecommendation: "refund", finalRecommendation: "refund", draftResponse: null, winProbability: 0.05, winLikelihoodLabel: "Weak", ...over });

/** An in-memory DisputeResolutionRepo with the same guard as the SQL: only an unresolved, non-seed, non-demo dispute changes. */
function fakeResolution(records: DisputeRecord[]): DisputeResolutionRepo & { calls: number; updates: number } {
  const state = { calls: 0, updates: 0 };
  return {
    get calls() { return state.calls; },
    get updates() { return state.updates; },
    async markResolvedOnPayPal({ id, status, outcome, note }) {
      state.calls++;
      const rec = records.find((r) => r.dispute.id === id);
      if (!rec || rec.dispute.isSeed || rec.dispute.isDemo || !["open", "action_taken"].includes(rec.dispute.status)) return null;
      state.updates++;
      rec.dispute = { ...rec.dispute, status, outcome, outcomeIsSimulated: false, reasoning: [rec.dispute.reasoning, note].filter(Boolean).join(" ") };
      return rec.dispute;
    },
  };
}

function setup(dispute = real(), paypal: Record<string, unknown | Error> = { [GET]: closed() }) {
  const records = [makeRecord(dispute)];
  const repo = createFakeDisputesRepo(records, artefactRows(ORDER_ID, SEED_C));
  const resolution = fakeResolution(records);
  const client = createFakePayPal(paypal);
  const logs: Array<{ toolName: string; outputSummary: string }> = [];
  const deps = { repo, paypal: client, demoMode: false, now: () => NOW, resolution, log: async (m: { toolName: string; outputSummary: string }) => void logs.push(m) };
  return { records, repo, resolution, client, deps, logs };
}

describe("mapPayPalResolution", () => {
  it("buyer's favour is a refund, seller's favour is a win", () => {
    expect(mapPayPalResolution({ outcomeCode: "RESOLVED_BUYER_FAVOUR" })).toMatchObject({ status: "resolved_refunded", outcome: "refunded" });
    expect(mapPayPalResolution({ outcomeCode: "RESOLVED_SELLER_FAVOUR" })).toMatchObject({ status: "resolved_won", outcome: "won" });
  });

  it("anything else is closed with NO outcome claimed (never a guessed win)", () => {
    for (const code of ["CANCELED_BY_BUYER", "DENIED", "RESOLVED_WITH_PAYOUT", "SOMETHING_NEW", null, undefined]) {
      expect(mapPayPalResolution({ outcomeCode: code })).toMatchObject({ status: "resolved_closed", outcome: null });
    }
  });

  it("recognises a closed dispute from its status, state or outcome", () => {
    expect(isClosedOnPayPal({ status: "RESOLVED" })).toBe(true);
    expect(isClosedOnPayPal({ disputeState: "RESOLVED" })).toBe(true);
    expect(isClosedOnPayPal({ outcomeCode: "RESOLVED_BUYER_FAVOUR" })).toBe(true);
    expect(isClosedOnPayPal({ status: "WAITING_FOR_SELLER_RESPONSE", disputeState: "REQUIRED_ACTION" })).toBe(false);
  });

  it("says what happened in plain words", () => {
    expect(describeResolution(mapPayPalResolution({ outcomeCode: "RESOLVED_BUYER_FAVOUR" }), "SELLER_ISSUED_REFUND")).toBe("PayPal closed this dispute in the buyer's favour (seller issued refund). The buyer was refunded.");
    expect(describeResolution(mapPayPalResolution({ outcomeCode: "CANCELED_BY_BUYER" }))).toContain("No refund or win is recorded here");
  });
});

describe("a dispute PayPal has closed (the page read)", () => {
  it("is marked resolved with PayPal's outcome, shows 'Resolved on PayPal' and offers no Approve, Reject or Retry", async () => {
    const { deps, records } = setup();
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, deps))!;
    expect(records[0]!.dispute).toMatchObject({ status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: false });
    expect(detail.view).toMatchObject({ status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: false });
    expect(detail.panel).toMatchObject({ mode: "resolved_on_paypal", message: expect.stringContaining("buyer's favour") });
    expect(detail.view.analysis?.reasoning).toContain("PayPal closed this dispute in the buyer's favour");
  });

  it("creates NO approval, NO execution and NO learning-loop increment", async () => {
    const { deps, repo } = setup();
    await loadDisputeDetail(DISPUTE_ID, SESSION, deps);
    expect(repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 0 });
    expect(repo.outcomes).toHaveLength(0);
    expect(repo.counter.value).toBe(0);
  });

  it("is idempotent: the next read changes nothing more and still shows 'Resolved on PayPal'", async () => {
    const { deps, resolution, records } = setup();
    await loadDisputeDetail(DISPUTE_ID, SESSION, deps);
    const after = JSON.stringify(records[0]!.dispute);
    const second = (await loadDisputeDetail(DISPUTE_ID, SESSION, deps))!;
    expect(resolution.updates).toBe(1);
    expect(JSON.stringify(records[0]!.dispute)).toBe(after);
    expect(second.panel.mode).toBe("resolved_on_paypal");
  });

  it("a closure PayPal gives no outcome for is recorded as resolved on PayPal with no outcome", async () => {
    const { deps, records } = setup(real(), { [GET]: closed({ dispute_outcome: { outcome_code: "CANCELED_BY_BUYER" } }) });
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, deps))!;
    expect(records[0]!.dispute).toMatchObject({ status: "resolved_closed", outcome: null });
    expect(detail.panel.mode).toBe("resolved_on_paypal");
  });

  it("the real case: approved, the live write failed (422), then PayPal shows it closed: still no execution, no outcome row", async () => {
    const { deps, repo, records } = setup(real(), { [GET]: open(), [`POST /v1/customer/disputes/${PP}/accept-claim`]: new PayPalError("PayPal POST failed with HTTP 422", 422, "dbg-1") });
    const approveDeps = { repo, executor: { paypal: deps.paypal, demoMode: false, now: () => NOW }, liveGate: createLiveGate(deps.paypal, false), newRequestId: () => "req-1", now: () => NOW };
    expect((await approveDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" }, approveDeps)).kind).toBe("execution_failed");
    expect(repo.inserts).toMatchObject({ approvals: 1, executions: 1 });

    (deps.paypal as ReturnType<typeof createFakePayPal>).request.mockImplementation(async (_p: string, _i: unknown, schema: { parse(v: unknown): unknown }) => schema.parse(closed()));
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, deps))!;
    expect(detail.panel.mode).toBe("resolved_on_paypal");
    expect(records[0]!.dispute.status).toBe("resolved_refunded");
    expect(repo.executions[0]!.executedAt).toBeNull(); // it was never executed by the app
    expect(repo.inserts).toMatchObject({ approvals: 1, executions: 1 }); // nothing added by the closure
    expect(repo.outcomes).toHaveLength(0);
    expect(repo.counter.value).toBe(0);
  });

  it("logs that PayPal closed it, and says nothing was approved, executed or learned", async () => {
    const { deps, logs } = setup();
    await loadDisputeDetail(DISPUTE_ID, SESSION, deps);
    const row = logs.find((l) => l.toolName === "dispute_resolved_on_paypal");
    expect(row?.outputSummary).toContain("RESOLVED_BUYER_FAVOUR");
    expect(row?.outputSummary).toContain("no approval, execution or learning-loop change");
  });

  it("an open dispute on PayPal is left alone", async () => {
    const { deps, resolution, records } = setup(real(), { [GET]: open() });
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, deps))!;
    expect(resolution.calls).toBe(0);
    expect(records[0]!.dispute.status).toBe("open");
    expect(detail.panel.mode).toBe("decide");
  });

  it("never touches a seeded or demo dispute, and never calls PayPal for one", async () => {
    for (const over of [{ isDemo: true, paypalDisputeId: null }, { isSeed: true, isDemo: true, sessionId: null }]) {
      const { deps, resolution, client, records } = setup(real(over));
      await loadDisputeDetail(DISPUTE_ID, SESSION, deps);
      expect(resolution.calls).toBe(0);
      expect(client.request).not.toHaveBeenCalled();
      expect(records[0]!.dispute.status).toBe("open");
    }
  });

  it("does nothing when PayPal cannot be read (no guess, no change)", async () => {
    const { deps, resolution, records } = setup(real(), { [GET]: new PayPalError("down", 503) });
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, deps))!;
    expect(resolution.calls).toBe(0);
    expect(records[0]!.dispute.status).toBe("open");
    expect(detail.panel.mode).not.toBe("resolved_on_paypal");
  });

  it("a dispute the merchant resolved here (executed) is NOT relabelled 'Resolved on PayPal'", async () => {
    const { deps, repo } = setup(real(), { [GET]: open(), [`POST /v1/customer/disputes/${PP}/accept-claim`]: {} });
    const approveDeps = { repo, executor: { paypal: deps.paypal, demoMode: false, now: () => NOW }, liveGate: createLiveGate(deps.paypal, false), newRequestId: () => "req-2", now: () => NOW };
    expect((await approveDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" }, approveDeps)).kind).toBe("executed");
    (deps.paypal as ReturnType<typeof createFakePayPal>).request.mockImplementation(async (_p: string, _i: unknown, schema: { parse(v: unknown): unknown }) => schema.parse(closed()));
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, deps))!;
    expect(detail.panel).toMatchObject({ mode: "done", action: "accept_claim", simulated: false });
  });
});
