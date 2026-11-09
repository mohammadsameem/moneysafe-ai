import { describe, expect, it } from "vitest";
import type { ActionExecution, ApprovalRecord } from "@/db/schema";
import { toDisputeView } from "../read";
import { STEP_LABELS, buildTimeline, type TimelineInput } from "../timeline";
import { DISPUTE_ID, NOW, analysed, makeDispute, makeRecord } from "./fakes";

const T = {
  created: "2026-11-07T08:00:00.000Z",
  evidence: "2026-11-01T08:00:00.000Z",
  analysis: "2026-11-07T09:00:00.000Z",
  decided: "2026-11-08T10:00:00.000Z",
  executed: "2026-11-08T10:00:05.000Z",
  resolved: "2026-10-01T00:00:00.000Z",
};
const approval = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: "appr-1", disputeId: DISPUTE_ID, actionType: "submit_evidence", merchantUserId: "m", decision: "approved", payloadHash: "h", createdAt: T.decided, ...over,
});
const execution = (over: Partial<ActionExecution> = {}): ActionExecution => ({
  id: "exec-1", approvalRecordId: "appr-1", disputeId: DISPUTE_ID, actionType: "submit_evidence", approvedPayload: {}, originalDraft: "d", editedDraft: null,
  paypalRequestId: "r", paypalResponse: null, executedAt: T.executed, isSimulated: false, createdAt: T.decided, ...over,
});

function input(disputeOver: Parameters<typeof analysed>[0] = {}, history: Partial<TimelineInput["history"]> = {}, evidence = { count: 8, latestAt: T.evidence }): TimelineInput {
  const view = toDisputeView(makeRecord(analysed({ createdAt: T.created, analysisComputedAt: T.analysis, ...disputeOver })), NOW);
  return { view, evidence, history: { approvals: [], executions: [], ...history } };
}
const byKey = (steps: ReturnType<typeof buildTimeline>) => Object.fromEntries(steps.map((s) => [s.key, s]));

describe("buildTimeline", () => {
  it("always has the six steps, in order, with the spec's labels", () => {
    const steps = buildTimeline(input());
    expect(steps.map((s) => s.label)).toEqual([
      "Dispute created",
      "Evidence assembled",
      "AI analysis completed",
      "Draft created",
      "Merchant decision",
      "PayPal action executed",
    ]);
    expect(Object.values(STEP_LABELS)).toHaveLength(6);
  });

  it("a freshly analysed contest: first four done with their database timestamps, decision and action pending", () => {
    const s = byKey(buildTimeline(input()));
    expect(s.created).toMatchObject({ status: "done", at: T.created });
    expect(s.evidence).toMatchObject({ status: "done", at: T.evidence, detail: "8 evidence items on file." });
    expect(s.analysis).toMatchObject({ status: "done", at: T.analysis, detail: "Recommendation: Contest." });
    expect(s.draft).toMatchObject({ status: "done", at: T.analysis });
    expect(s.decision).toMatchObject({ status: "pending", at: null, detail: "Waiting for your decision." });
    expect(s.action).toMatchObject({ status: "pending", at: null, simulated: false });
  });

  it("a refund recommendation skips the draft", () => {
    const s = byKey(buildTimeline(input({ finalRecommendation: "refund", systemRecommendation: "refund", draftResponse: null })));
    expect(s.draft).toMatchObject({ status: "skipped", detail: "Not needed: the recommendation is a refund." });
  });

  it("an AI-unavailable analysis says so", () => {
    const s = byKey(buildTimeline(input({ winProbability: null, winLikelihoodLabel: null, llmAdjustment: null })));
    expect(s.analysis?.detail).toBe("System recommendation only (the AI step was unavailable): Contest.");
  });

  it("not analysed yet: analysis and draft pending, no timestamps", () => {
    const view = toDisputeView(makeRecord(makeDispute({ createdAt: T.created })), NOW);
    const s = byKey(buildTimeline({ view, evidence: { count: 0, latestAt: null }, history: { approvals: [], executions: [] } }));
    expect(s.evidence).toMatchObject({ status: "pending", detail: "No evidence on file yet." });
    expect(s.analysis).toMatchObject({ status: "pending", at: null });
    expect(s.draft).toMatchObject({ status: "pending", detail: "Waiting for the analysis." });
  });

  it("approved and simulated: decision and action done, the action labelled simulated", () => {
    const s = byKey(buildTimeline(input({}, { approvals: [approval()], executions: [execution({ isSimulated: true })] })));
    expect(s.decision).toMatchObject({ status: "done", at: T.decided, detail: "Approved the response." });
    expect(s.action).toMatchObject({ status: "done", at: T.executed, simulated: true, detail: "Simulated: evidence submitted. Nothing was sent to PayPal." });
  });

  it("approved with edits, sent live", () => {
    const s = byKey(buildTimeline(input({}, { approvals: [approval()], executions: [execution({ editedDraft: "mine" })] })));
    expect(s.decision?.detail).toBe("Approved the response with your edits.");
    expect(s.action).toMatchObject({ status: "done", simulated: false, detail: "PayPal confirmed: evidence submitted." });
  });

  it("approved but the PayPal call failed: action 'failed', with no timestamp", () => {
    const s = byKey(buildTimeline(input({}, { approvals: [approval()], executions: [execution({ executedAt: null })] })));
    expect(s.action).toMatchObject({ status: "failed", at: null });
    expect(s.action?.detail).toContain("Retry");
  });

  it("rejected: decision done ('Rejected'), action skipped", () => {
    const s = byKey(buildTimeline(input({}, { approvals: [approval({ decision: "rejected" })] })));
    expect(s.decision).toMatchObject({ status: "done", detail: "Rejected the response. Nothing was sent to PayPal." });
    expect(s.action).toMatchObject({ status: "skipped", detail: "Not executed: you rejected the action." });
  });

  it("rejected then approved: the latest decision counts", () => {
    const s = byKey(
      buildTimeline(input({}, { approvals: [approval({ id: "r1", decision: "rejected", createdAt: "2026-11-08T09:00:00.000Z" }), approval({ id: "appr-1" })], executions: [execution()] })),
    );
    expect(s.decision).toMatchObject({ at: T.decided, detail: "Approved the response." });
    expect(s.action?.status).toBe("done");
  });

  it("a simulated refund", () => {
    const s = byKey(
      buildTimeline(input({ status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: true, finalRecommendation: "refund", draftResponse: null }, {
        approvals: [approval({ actionType: "accept_claim" })],
        executions: [execution({ actionType: "accept_claim", isSimulated: true })],
      })),
    );
    expect(s.decision?.detail).toBe("Approved the refund.");
    expect(s.action).toMatchObject({ status: "done", simulated: true, detail: "Simulated: claim accepted and refunded. Nothing was sent to PayPal." });
  });

  it("a historical resolved dispute: decision skipped, action done at the resolution date", () => {
    const s = byKey(buildTimeline(input({ status: "resolved_won", outcome: "won", draftResponse: null, updatedAt: T.resolved })));
    expect(s.decision).toMatchObject({ status: "skipped", detail: "No decision recorded here (historical record)." });
    expect(s.action).toMatchObject({ status: "done", at: T.resolved, simulated: false, detail: "Resolved: Won (historical record)." });
    expect(s.draft?.status).toBe("skipped");
  });

  it("a simulated outcome is labelled simulated", () => {
    const s = byKey(buildTimeline(input({ status: "resolved_lost", outcome: "lost", outcomeIsSimulated: true })));
    expect(s.action).toMatchObject({ simulated: true, detail: "Resolved: Lost (simulated outcome)." });
  });

  it("uses only timestamps from the input (nothing invented)", () => {
    const allowed = new Set(Object.values(T));
    for (const st of buildTimeline(input({}, { approvals: [approval()], executions: [execution()] }))) {
      if (st.at !== null) expect(allowed.has(st.at), st.key).toBe(true);
    }
  });
});
