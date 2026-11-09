import { describe, expect, it } from "vitest";
import { SEED_C, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import { approveDispute, rejectDispute } from "../approve";
import { derivePanelState, loadDisputeDetail } from "../detail";
import { toDisputeView } from "../read";
import { demoCopyId } from "@/lib/demo/ids";
import { DISPUTE_ID, NOW, ORDER_ID, OTHER_SESSION, SESSION, analysed, createFakeDisputesRepo, makeDispute, makeRecord } from "./fakes";
import { PayPalError, type PayPalClient } from "@/lib/paypal";

type Over = Parameters<typeof analysed>[0];
const failingPayPal = () => ({ request: async () => { throw new PayPalError("PayPal could not be reached"); } }) as unknown as PayPalClient;

function setup(over: Over = {}, opts: { demoMode?: boolean } = {}) {
  const repo = createFakeDisputesRepo([makeRecord(analysed({ isSeed: false, isDemo: false, paypalDisputeId: "PP-D-1", ...over }))], artefactRows(ORDER_ID, SEED_C));
  const deps = { repo, paypal: null, demoMode: opts.demoMode ?? false, now: () => NOW };
  return { repo, deps };
}
const load = (deps: ReturnType<typeof setup>["deps"], sessionId = SESSION) => loadDisputeDetail(DISPUTE_ID, sessionId, deps);
const approve = (repo: ReturnType<typeof setup>["repo"], paypal: PayPalClient | null, action: "submit_evidence" | "accept_claim" = "submit_evidence", editedDraft?: string) =>
  approveDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action, editedDraft }, { repo, executor: { paypal, demoMode: false, now: () => NOW }, now: () => NOW });

describe("loadDisputeDetail", () => {
  it("returns the stored analysis, the evidence summary and a 'decide' panel with the draft for a fresh contest", async () => {
    const { deps } = setup();
    const d = await load(deps);
    expect(d?.view.analysis).toMatchObject({ finalRecommendation: "contest", winProbability: 0.95 });
    expect(d?.evidence.count).toBe(SEED_C.length);
    expect(d?.evidence.latestAt).toBe("2026-11-01T08:00:00.000Z");
    expect(d?.panel).toEqual({ mode: "decide", action: "submit_evidence", draft: expect.stringContaining("Hello PayPal"), rejectedAt: null });
    expect(d?.willSimulate).toBe(false);
    expect(d?.renderedAt).toBe(NOW.toISOString());
  });

  it("a refund recommendation gives a 'decide' panel for accept_claim with no draft", async () => {
    const { deps } = setup({ finalRecommendation: "refund", systemRecommendation: "refund", draftResponse: null });
    expect((await load(deps))?.panel).toEqual({ mode: "decide", action: "accept_claim", draft: null, rejectedAt: null });
  });

  it("will simulate for seeded and demo disputes, and in Demo Mode", async () => {
    expect((await load(setup({ isSeed: true, sessionId: null }).deps))?.willSimulate).toBe(true);
    expect((await load(setup({ isDemo: true }).deps))?.willSimulate).toBe(true);
    expect((await load(setup({}, { demoMode: true }).deps))?.willSimulate).toBe(true);
  });

  it("an open shared seed shows the 'shared_example' panel with this session's copy id (M3-08)", async () => {
    const d = await load(setup({ isSeed: true, isDemo: true, sessionId: null }).deps);
    expect(d?.panel).toEqual({ mode: "shared_example", copyId: demoCopyId(SESSION, DISPUTE_ID) });
    expect(d?.canSimulateOutcome).toBe(false);
    // A resolved seed (H1-H5) is still just 'resolved'.
    expect((await load(setup({ isSeed: true, sessionId: null, status: "resolved_won", outcome: "won" }).deps))?.panel).toEqual({ mode: "resolved" });
  });

  it("after a rejection the panel still offers the decision, with when it was rejected", async () => {
    const { repo, deps } = setup();
    await rejectDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "submit_evidence" }, { repo, now: () => NOW });
    expect((await load(deps))?.panel).toMatchObject({ mode: "decide", rejectedAt: NOW.toISOString() });
  });

  it("after a failed live call the panel is 'retry'", async () => {
    const { repo, deps } = setup();
    expect((await approve(repo, failingPayPal())).kind).toBe("execution_failed");
    expect((await load(deps))?.panel).toMatchObject({ mode: "retry", action: "submit_evidence" });
  });

  it("after a simulated approval the panel is 'done' (Action already executed), marked simulated and edited", async () => {
    const { repo, deps } = setup({ isDemo: true, sessionId: SESSION });
    expect((await approve(repo, null, "submit_evidence", "My own words.")).kind).toBe("executed");
    const d = await load(deps);
    expect(d?.panel).toEqual({ mode: "done", action: "submit_evidence", executedAt: NOW.toISOString(), simulated: true, edited: true });
    expect(d?.view.status).toBe("action_taken");
    expect(d?.history.approvals).toHaveLength(1);
    expect(d?.history.executions).toHaveLength(1);
  });

  it("a simulated refund resolves the dispute but the panel still says the action was executed", async () => {
    const { repo, deps } = setup({ isDemo: true, sessionId: SESSION, finalRecommendation: "refund", systemRecommendation: "refund", draftResponse: null });
    await approve(repo, null, "accept_claim");
    const d = await load(deps);
    expect(d?.view.status).toBe("resolved_refunded");
    expect(d?.panel).toMatchObject({ mode: "done", action: "accept_claim", simulated: true, edited: false });
  });

  it("a resolved historical dispute with no action here is 'resolved'", async () => {
    const { deps } = setup({ status: "resolved_won", outcome: "won", draftResponse: null });
    expect((await load(deps))?.panel).toEqual({ mode: "resolved" });
  });

  it("a dispute with no analysis, or only an in-flight claim, is 'no_analysis'", async () => {
    expect((await load(setup({ analysisComputedAt: null, finalRecommendation: null }).deps))?.panel).toEqual({ mode: "no_analysis" });
    const claimed = await load(setup({ analysisComputedAt: `pending:${NOW.toISOString()}|x` }).deps);
    expect(claimed?.panel).toEqual({ mode: "no_analysis" });
    expect(claimed?.view.analysis).toBeNull();
  });

  it("is null for another session's dispute and for unknown ids", async () => {
    const { deps } = setup();
    expect(await load(deps, OTHER_SESSION)).toBeNull();
    expect(await loadDisputeDetail("nope", SESSION, deps)).toBeNull();
  });

  it("returns only plain data (it is passed to client components)", async () => {
    const d = await load(setup().deps);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe("derivePanelState edge cases", () => {
  it("an executed action wins over everything, including a resolved status", () => {
    const record = makeRecord(analysed({ status: "resolved_refunded", outcome: "refunded" }));
    const execution = { actionType: "accept_claim", executedAt: NOW.toISOString(), isSimulated: false, editedDraft: null };
    const state = { kind: "already_executed", approval: {}, execution } as unknown as Parameters<typeof derivePanelState>[2];
    expect(derivePanelState(toDisputeView(record, NOW), record.dispute.analysisComputedAt, state, [])).toMatchObject({ mode: "done", action: "accept_claim", simulated: false });
  });

  it("an open dispute that is somehow no longer 'open' without an execution is treated as resolved, never as decidable", () => {
    const record = makeRecord(analysed({ status: "action_taken" }));
    expect(derivePanelState(toDisputeView(record, NOW), record.dispute.analysisComputedAt, { kind: "first" }, [])).toEqual({ mode: "resolved" });
  });

  it("a rejection of the OTHER action does not show as a rejection of this one", () => {
    const record = makeRecord(analysed());
    const other = { id: "r", disputeId: DISPUTE_ID, actionType: "accept_claim", decision: "rejected", createdAt: NOW.toISOString() } as unknown as Parameters<typeof derivePanelState>[3][number];
    expect(derivePanelState(toDisputeView(record, NOW), record.dispute.analysisComputedAt, { kind: "first" }, [other])).toMatchObject({ mode: "decide", rejectedAt: null });
  });

  it("a non-analysed dispute is never decidable even if the view somehow had an analysis", () => {
    const record = makeRecord(makeDispute({ analysisComputedAt: null }));
    expect(derivePanelState(toDisputeView(record, NOW), null, { kind: "first" }, [])).toEqual({ mode: "no_analysis" });
  });
});
