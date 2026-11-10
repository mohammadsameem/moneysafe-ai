/**
 * Approve / reject a dispute action (M2-04, REQ-DIS-05..09).
 *
 * The merchant approves the action the analysis recommended (contest -> submit_evidence, refund ->
 * accept_claim). The three-way branch is decided by resolveApprovalState:
 *   already_executed -> "Action already executed"; insert nothing, send nothing
 *   retry            -> reuse the stored execution and its PayPal-Request-Id; insert nothing
 *   first            -> store the approval + execution in one transaction, then execute
 * Nothing reaches PayPal (or is simulated) unless an approved record exists, and the model output
 * never triggers any of this: only a merchant's request does.
 */
import { createHash } from "node:crypto";
import type { ActionExecution, Dispute } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { ACCEPT_CLAIM_NOTE, EVIDENCE_NOTES_MAX_CHARS, buildProvideEvidencePayload } from "@/lib/paypal/evidence-payload";
import { isAnalysed } from "./analysis-state";
import { createApprovalWithExecution, resolveApprovalState, type ApprovalState } from "./approval";
import { executeApproved, type ExecutorDeps } from "./executor";
import { isRealDispute } from "./paypal-reason";
import { toDisputeView, type DisputeView } from "./read";
import { ApprovalConflictError, type DisputeActionType, type DisputesRepo } from "./types";

export interface ApproveDeps {
  repo: DisputesRepo;
  executor: Omit<ExecutorDeps, "repo">;
  newRequestId?: () => string;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
  /**
   * For a REAL PayPal dispute only: a fresh check that PayPal allows this action now and that nothing would be simulated.
   * Production always provides it (see runtime.ts); it is optional only so the demo-data tests stay as they are.
   */
  liveGate?: (dispute: Dispute, action: DisputeActionType) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface ActionRequest {
  disputeId: string;
  sessionId: string;
  /** The merchant recorded on the approval (REQ-DIS-06). */
  merchantUserId: string;
  action: DisputeActionType;
}

export interface ApproveRequest extends ActionRequest {
  /** The merchant's edited version of the draft (submit_evidence only). */
  editedDraft?: string | null;
}

export interface PublicExecution {
  executedAt: string | null;
  isSimulated: boolean;
}

export type ApproveResult =
  | { kind: "executed"; simulated: boolean; retried: boolean; outcomeRecorded: boolean; execution: PublicExecution; view: DisputeView }
  | { kind: "already_executed"; execution: PublicExecution; view: DisputeView }
  /** The live call failed. Nothing was marked done; the next approve is a retry with the same request id. */
  | { kind: "execution_failed"; message: string; execution: PublicExecution; view: DisputeView }
  | { kind: "not_found" }
  /** A shared seed: read-only for everyone; use Start demo for an own copy. */
  | { kind: "shared_example" }
  | { kind: "not_analyzed" }
  | { kind: "wrong_action"; expected: DisputeActionType }
  | { kind: "not_open" }
  | { kind: "invalid"; message: string }
  /** A real PayPal dispute where PayPal does not allow this action now (or cannot be read). Nothing was stored or sent. */
  | { kind: "live_blocked"; message: string };

export function expectedAction(finalRecommendation: Dispute["finalRecommendation"]): DisputeActionType | null {
  if (finalRecommendation === "contest") return "submit_evidence";
  if (finalRecommendation === "refund") return "accept_claim";
  return null;
}

/** JSON with sorted keys, so the same payload always hashes the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of the action payload (REQ-DIS-06). */
export function hashPayload(action: DisputeActionType, payload: unknown): string {
  return createHash("sha256").update(stableStringify({ action, payload })).digest("hex");
}

const publicExecution = (e: ActionExecution): PublicExecution => ({ executedAt: e.executedAt, isSimulated: e.isSimulated });

export async function approveDispute(req: ApproveRequest, deps: ApproveDeps): Promise<ApproveResult> {
  const now = (deps.now ?? (() => new Date()))();
  const record = await deps.repo.findVisible(req.disputeId, req.sessionId);
  if (!record) return { kind: "not_found" };
  const { dispute, order } = record;
  // Seeds are shared by every session: approving one would change it for everyone (M3-08).
  if (dispute.isSeed) return { kind: "shared_example" };

  const expected = expectedAction(dispute.finalRecommendation);
  if (!isAnalysed(dispute.analysisComputedAt) || expected === null) return { kind: "not_analyzed" };
  if (req.action !== expected) return { kind: "wrong_action", expected };

  const started = Date.now();
  const log = async (toolName: string, inputSummary: string, outputSummary: string, status: ActivityMeta["status"]) => {
    try {
      await deps.log?.({ sessionId: req.sessionId, refDisputeId: dispute.id, refOrderId: order.id, stepType: "merchant_action", toolName, inputSummary, outputSummary, durationMs: Date.now() - started, status });
    } catch {
      /* logging is best effort */
    }
  };
  const reread = async (): Promise<DisputeView> => {
    const current = await deps.repo.findVisible(req.disputeId, req.sessionId);
    return toDisputeView(current ?? record, now);
  };

  let state: ApprovalState = await resolveApprovalState(deps.repo, dispute.id, req.action);

  // BRANCH A: already executed. Insert nothing, send nothing.
  if (state.kind === "already_executed") {
    return { kind: "already_executed", execution: publicExecution(state.execution), view: await reread() };
  }

  // A REAL PayPal dispute: only an action PayPal allows right now may go ahead, before anything is stored or sent.
  if (deps.liveGate && isRealDispute(dispute)) {
    const gate = await deps.liveGate(dispute, req.action);
    if (!gate.ok) return { kind: "live_blocked", message: gate.message };
  }

  let retried = state.kind === "retry";
  if (state.kind === "first") {
    // BRANCH C: first approval. Everything that can be refused is refused BEFORE anything is stored.
    if (dispute.status !== "open") return { kind: "not_open" };

    const built = buildAction(req, dispute, await deps.repo.getArtefacts(order.id));
    if (!built.ok) return { kind: "invalid", message: built.message };

    try {
      const created = await createApprovalWithExecution(
        deps.repo,
        {
          disputeId: dispute.id,
          actionType: req.action,
          merchantUserId: req.merchantUserId,
          payloadHash: hashPayload(req.action, built.payload),
          approvedPayload: built.payload,
          originalDraft: built.originalDraft,
          editedDraft: built.editedDraft,
        },
        deps.newRequestId,
      );
      state = { kind: "retry", approval: created.approval, execution: created.execution };
      retried = false;
      await log("approve_dispute_action", `approve ${req.action}${built.editedDraft ? " (edited)" : " (as drafted)"}`, "approval recorded", "success");
    } catch (err) {
      if (!(err instanceof ApprovalConflictError)) throw err;
      // Another request approved first. Continue from whatever it stored; never insert a second execution.
      state = await resolveApprovalState(deps.repo, dispute.id, req.action);
      if (state.kind === "already_executed") {
        return { kind: "already_executed", execution: publicExecution(state.execution), view: await reread() };
      }
      if (state.kind === "first") throw err; // the conflicting row vanished: not something to paper over
      retried = true;
    }
  } else {
    await log("retry_dispute_action", `retry ${req.action}`, "reusing the stored approval and PayPal request id", "success");
  }

  // Execute step (BRANCH B and C): same code, same stored execution row.
  const result = await executeApproved(
    { dispute, order, approval: state.approval, execution: state.execution, sessionId: req.sessionId },
    { ...deps.executor, repo: deps.repo, now: deps.now ?? deps.executor.now },
  );

  switch (result.kind) {
    case "executed":
      return { kind: "executed", simulated: result.simulated, retried, outcomeRecorded: result.outcomeRecorded, execution: publicExecution(result.execution), view: await reread() };
    case "already_executed":
      return { kind: "already_executed", execution: publicExecution(result.execution), view: await reread() };
    case "failed":
      return { kind: "execution_failed", message: result.message, execution: publicExecution(result.execution), view: await reread() };
  }
}

type BuiltAction =
  | { ok: true; payload: Record<string, unknown>; originalDraft: string | null; editedDraft: string | null }
  | { ok: false; message: string };

/** The PayPal body and the draft bookkeeping for a FIRST approval. */
function buildAction(req: ApproveRequest, dispute: Dispute, artefacts: readonly { artefactType: string; payload: unknown }[]): BuiltAction {
  const edited = req.editedDraft?.trim() ? req.editedDraft.trim() : null;

  if (req.action === "accept_claim") {
    if (edited) return { ok: false, message: "A refund has no draft to edit." };
    return { ok: true, payload: { note: ACCEPT_CLAIM_NOTE, accept_claim_type: "REFUND" }, originalDraft: null, editedDraft: null };
  }

  const original = dispute.draftResponse?.trim() ? dispute.draftResponse.trim() : null;
  const finalDraft = edited ?? original;
  if (!finalDraft) return { ok: false, message: "There is no draft response to send. Write one, then approve." };
  if (finalDraft.length > EVIDENCE_NOTES_MAX_CHARS) {
    return { ok: false, message: `The response is ${finalDraft.length} characters; PayPal accepts at most ${EVIDENCE_NOTES_MAX_CHARS}.` };
  }
  const built = buildProvideEvidencePayload(dispute, finalDraft, artefacts);
  if (!built.ok) return { ok: false, message: built.message };
  return {
    ok: true,
    payload: built.payload as unknown as Record<string, unknown>,
    originalDraft: original,
    // Recorded as "edited" only when it really differs from what the system wrote.
    editedDraft: edited !== null && edited !== original ? edited : null,
  };
}

export type RejectResult =
  | { kind: "rejected"; view: DisputeView }
  | { kind: "not_found" }
  | { kind: "shared_example" }
  | { kind: "not_analyzed" }
  | { kind: "wrong_action"; expected: DisputeActionType }
  | { kind: "not_open" }
  /** An approved record already exists for this action, so it can no longer be rejected. */
  | { kind: "already_approved" };

export async function rejectDispute(req: ActionRequest, deps: Pick<ApproveDeps, "repo" | "now" | "log">): Promise<RejectResult> {
  const now = (deps.now ?? (() => new Date()))();
  const record = await deps.repo.findVisible(req.disputeId, req.sessionId);
  if (!record) return { kind: "not_found" };
  const { dispute, order } = record;
  if (dispute.isSeed) return { kind: "shared_example" };

  const expected = expectedAction(dispute.finalRecommendation);
  if (!isAnalysed(dispute.analysisComputedAt) || expected === null) return { kind: "not_analyzed" };
  if (req.action !== expected) return { kind: "wrong_action", expected };
  // Checked before the status: once an action is approved the dispute is no longer open, and
  // "already approved" tells the merchant more than "not open".
  if (await deps.repo.findApprovedApproval(dispute.id, req.action)) return { kind: "already_approved" };
  if (dispute.status !== "open") return { kind: "not_open" };

  const started = Date.now();
  await deps.repo.insertRejection({
    disputeId: dispute.id,
    actionType: req.action,
    merchantUserId: req.merchantUserId,
    payloadHash: hashPayload(req.action, { decision: "rejected", draft: dispute.draftResponse }),
  });
  try {
    await deps.log?.({
      sessionId: req.sessionId,
      refDisputeId: dispute.id,
      refOrderId: order.id,
      stepType: "merchant_action",
      toolName: "reject_dispute_action",
      inputSummary: `reject ${req.action}`,
      outputSummary: "rejection recorded; no action was taken",
      durationMs: Date.now() - started,
      status: "success",
    });
  } catch {
    /* logging is best effort */
  }
  const current = await deps.repo.findVisible(req.disputeId, req.sessionId);
  return { kind: "rejected", view: toDisputeView(current ?? record, now) };
}
