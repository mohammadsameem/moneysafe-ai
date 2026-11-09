/**
 * The dispute timeline (M2-08, REQ-DIS-10): six fixed steps, each with a timestamp from the
 * database, a status and, where it applies, a "simulated" label. Pure.
 *
 *   1 dispute created  2 evidence assembled  3 AI analysis completed  4 draft created
 *   5 merchant decision  6 PayPal action executed (or simulated)
 */
import type { ActionExecution, ApprovalRecord } from "@/db/schema";
import { OUTCOME_LABEL, RECOMMENDATION_LABEL } from "./present";
import type { DisputeView } from "./read";

export type StepStatus = "done" | "pending" | "skipped" | "failed";
export type StepKey = "created" | "evidence" | "analysis" | "draft" | "decision" | "action";

export interface TimelineStep {
  key: StepKey;
  label: string;
  status: StepStatus;
  /** ISO time the step happened, from the database; null if it has not happened. */
  at: string | null;
  detail: string;
  simulated: boolean;
}

export interface TimelineInput {
  view: Pick<DisputeView, "createdAt" | "status" | "outcome" | "outcomeIsSimulated" | "resolvedAt" | "analysis">;
  evidence: { count: number; latestAt: string | null };
  history: { approvals: readonly ApprovalRecord[]; executions: readonly ActionExecution[] };
}

export const STEP_LABELS: Record<StepKey, string> = {
  created: "Dispute created",
  evidence: "Evidence assembled",
  analysis: "AI analysis completed",
  draft: "Draft created",
  decision: "Merchant decision",
  action: "PayPal action executed",
};

const ACTION_LABEL = { submit_evidence: "evidence submitted", accept_claim: "claim accepted and refunded" } as const;
const latest = <T extends { createdAt: string }>(rows: readonly T[]): T | undefined =>
  rows.reduce<T | undefined>((a, b) => (a === undefined || b.createdAt > a.createdAt ? b : a), undefined);
const isResolved = (status: string) => status.startsWith("resolved_");

export function buildTimeline({ view, evidence, history }: TimelineInput): TimelineStep[] {
  const step = (key: StepKey, status: StepStatus, at: string | null, detail: string, simulated = false): TimelineStep => ({
    key,
    label: STEP_LABELS[key],
    status,
    at,
    detail,
    simulated,
  });
  const resolved = isResolved(view.status);
  const analysis = view.analysis;
  const decision = latest(history.approvals);
  const execution = latest(history.executions);

  const steps: TimelineStep[] = [step("created", "done", view.createdAt, "The buyer opened the dispute.")];

  // 2. Evidence
  steps.push(
    evidence.count > 0
      ? step("evidence", "done", evidence.latestAt, `${evidence.count} evidence item${evidence.count === 1 ? "" : "s"} on file.`)
      : step("evidence", "pending", null, "No evidence on file yet."),
  );

  // 3. Analysis
  if (analysis) {
    const rec = analysis.finalRecommendation ? RECOMMENDATION_LABEL[analysis.finalRecommendation] : null;
    steps.push(
      step(
        "analysis",
        "done",
        analysis.computedAt,
        analysis.aiUnavailable ? `System recommendation only (the AI step was unavailable)${rec ? `: ${rec}` : ""}.` : `Recommendation: ${rec ?? "none"}.`,
      ),
    );
  } else {
    steps.push(resolved ? step("analysis", "skipped", null, "No analysis on file for this historical dispute.") : step("analysis", "pending", null, "Not analysed yet."));
  }

  // 4. Draft
  if (analysis?.draftResponse) steps.push(step("draft", "done", analysis.computedAt, "A response to PayPal is ready for your review."));
  else if (analysis?.finalRecommendation === "refund") steps.push(step("draft", "skipped", null, "Not needed: the recommendation is a refund."));
  else if (resolved) steps.push(step("draft", "skipped", null, "No draft on file for this historical dispute."));
  else steps.push(step("draft", "pending", null, analysis ? "No draft yet." : "Waiting for the analysis."));

  // 5. Merchant decision
  if (decision) {
    const matching = history.executions.find((e) => e.approvalRecordId === decision.id);
    const what = decision.actionType === "accept_claim" ? "the refund" : "the response";
    const detail =
      decision.decision === "rejected"
        ? `Rejected ${what}. Nothing was sent to PayPal.`
        : `Approved ${what}${matching?.editedDraft ? " with your edits" : ""}.`;
    steps.push(step("decision", "done", decision.createdAt, detail));
  } else {
    steps.push(resolved ? step("decision", "skipped", null, "No decision recorded here (historical record).") : step("decision", "pending", null, "Waiting for your decision."));
  }

  // 6. PayPal action
  if (execution?.executedAt) {
    const action = ACTION_LABEL[execution.actionType as keyof typeof ACTION_LABEL] ?? "action executed";
    steps.push(
      step("action", "done", execution.executedAt, execution.isSimulated ? `Simulated: ${action}. Nothing was sent to PayPal.` : `PayPal confirmed: ${action}.`, execution.isSimulated),
    );
  } else if (execution) {
    steps.push(step("action", "failed", null, "The last attempt to send this to PayPal failed. Retry from the decision panel; it is safe."));
  } else if (decision?.decision === "rejected") {
    steps.push(step("action", "skipped", null, "Not executed: you rejected the action."));
  } else if (resolved) {
    const outcome = view.outcome ? OUTCOME_LABEL[view.outcome] : "Resolved";
    steps.push(step("action", "done", view.resolvedAt, `Resolved: ${outcome}${view.outcomeIsSimulated ? " (simulated outcome)" : " (historical record)"}.`, view.outcomeIsSimulated));
  } else {
    steps.push(step("action", "pending", null, "Nothing has been sent to PayPal."));
  }

  return steps;
}
