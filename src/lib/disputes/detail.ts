/**
 * Everything the dispute detail page needs, in one serialisable object (M2-07, M2-08).
 *
 * The page renders the stored analysis straight away; only a dispute with NO analysis makes the
 * browser call POST /analyze. So the seeded disputes, which are analysed at seed time, open
 * instantly and never cause a model call.
 */
import type { ActionExecution, ApprovalRecord } from "@/db/schema";
import { shouldSimulateWrite } from "@/lib/paypal";
import { isAnalysed } from "./analysis-state";
import { resolveApprovalState, type ApprovalState } from "./approval";
import { expectedAction } from "./approve";
import { getDisputeView, isResolvedStatus, type DisputeReadDeps, type DisputeView } from "./read";
import type { DisputeActionType, DisputesRepo } from "./types";

export type PanelState =
  /** No analysis yet: the page is (or should be) analysing. */
  | { mode: "no_analysis" }
  /** The recommended action has not been approved yet. `rejectedAt` is set if the merchant rejected it before. */
  | { mode: "decide"; action: DisputeActionType; draft: string | null; rejectedAt: string | null }
  /** Approved, but the PayPal call did not go through: offer Retry (same request id). */
  | { mode: "retry"; action: DisputeActionType; approvedAt: string }
  /** The action ran (or was simulated). */
  | { mode: "done"; action: DisputeActionType; executedAt: string; simulated: boolean; edited: boolean }
  /** Resolved with no action taken here (the seeded history). */
  | { mode: "resolved" };

export interface EvidenceSummary {
  count: number;
  /** When the most recent artefact was added (the "evidence assembled" moment). */
  latestAt: string | null;
}

export interface DisputeDetail {
  view: DisputeView;
  order: { id: string; riskScore: number | null; verdict: "ship" | "verify" | "hold" | null };
  evidence: EvidenceSummary;
  panel: PanelState;
  history: { approvals: ApprovalRecord[]; executions: ActionExecution[] };
  /** True when approving would be simulated (Demo Mode, or a seeded / demo dispute). */
  willSimulate: boolean;
  renderedAt: string;
}

export function derivePanelState(
  view: DisputeView,
  rawAnalysisMarker: string | null,
  state: ApprovalState | null,
  approvals: readonly ApprovalRecord[],
): PanelState {
  const action = expectedAction(view.analysis?.finalRecommendation ?? null);

  if (state?.kind === "already_executed") {
    return {
      mode: "done",
      action: state.execution.actionType as DisputeActionType,
      executedAt: state.execution.executedAt!,
      simulated: state.execution.isSimulated,
      edited: state.execution.editedDraft !== null,
    };
  }
  if (isResolvedStatus(view.status)) return { mode: "resolved" };
  if (!isAnalysed(rawAnalysisMarker) || !view.analysis || !action) return { mode: "no_analysis" };
  if (state?.kind === "retry") return { mode: "retry", action, approvedAt: state.approval.createdAt };
  if (view.status !== "open") return { mode: "resolved" };

  const rejections = approvals.filter((a) => a.decision === "rejected" && a.actionType === action);
  return {
    mode: "decide",
    action,
    draft: action === "submit_evidence" ? view.analysis.draftResponse : null,
    rejectedAt: rejections.length > 0 ? rejections[rejections.length - 1]!.createdAt : null,
  };
}

export interface DetailDeps extends Omit<DisputeReadDeps, "repo"> {
  repo: DisputesRepo;
}

export async function loadDisputeDetail(id: string, sessionId: string, deps: DetailDeps): Promise<DisputeDetail | null> {
  const found = await getDisputeView(id, sessionId, deps);
  if (!found) return null;
  const { view, order, dispute } = found;

  const [artefacts, history] = await Promise.all([deps.repo.getArtefacts(order.id), deps.repo.getActionHistory(view.id)]);
  const action = expectedAction(view.analysis?.finalRecommendation ?? null);
  // The executed action may be either one (for example after an AI override); check both, recommended first.
  const actions: DisputeActionType[] = action ? [action, action === "submit_evidence" ? "accept_claim" : "submit_evidence"] : ["submit_evidence", "accept_claim"];
  let state: ApprovalState | null = null;
  for (const a of actions) {
    const s = await resolveApprovalState(deps.repo, view.id, a);
    if (s.kind === "already_executed") {
      state = s;
      break;
    }
    if (s.kind === "retry" && state === null) state = s;
  }

  const latestAt = artefacts.reduce<string | null>((latest, a) => (latest === null || a.createdAt > latest ? a.createdAt : latest), null);
  const now = (deps.now ?? (() => new Date()))();
  return {
    view,
    order: { id: order.id, riskScore: order.riskScore, verdict: order.verdict },
    evidence: { count: artefacts.length, latestAt },
    panel: derivePanelState(view, dispute.analysisComputedAt, state, history.approvals),
    history,
    willSimulate: shouldSimulateWrite(dispute, deps.demoMode),
    renderedAt: now.toISOString(),
  };
}
