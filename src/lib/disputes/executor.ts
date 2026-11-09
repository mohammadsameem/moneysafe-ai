/**
 * Executes an APPROVED dispute action (M2-05, REQ-DIS-07/09, REQ-NFR-03).
 *
 * The approve handler has already stored the approval record and the unexecuted action_executions
 * row (with its PayPal-Request-Id). This module never inserts either; it loads them, runs the
 * action through the approval gate (submitEvidence / acceptClaim -> requireApproval), then
 *   simulate (DEMO_MODE, seeded or demo dispute): no network call; or
 *   live: POST to PayPal with the STORED PayPal-Request-Id.
 * On success one transaction marks the execution done and applies the consequences. On a live
 * failure nothing is marked done, so the next click lands in the retry branch with the same id.
 */
import { z } from "zod";
import type { ActionExecution, ApprovalRecord, Dispute, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import {
  PayPalError,
  acceptClaim,
  shouldSimulateWrite,
  submitEvidence,
  type PayPalClient,
  type PayPalDisputeWrite,
} from "@/lib/paypal";
import { performLiveDisputeWrite } from "@/lib/paypal/dispute-writes";
import type { DisputeActionType, ExecutionRepo, OutcomeRecordedEvent, RefundOutcomeInput } from "./types";

const ProvideEvidenceSchema = z.object({
  evidences: z
    .array(
      z.object({
        evidence_type: z.string().min(1),
        evidence_info: z.object({ tracking_info: z.array(z.object({ carrier_name: z.string(), tracking_number: z.string() }).passthrough()) }).optional(),
        documents: z.array(z.object({ name: z.string() })).optional(),
        notes: z.string().optional(),
        date: z.string().optional(),
      }),
    )
    .min(1),
});
const AcceptClaimSchema = z.object({ note: z.string(), accept_claim_type: z.literal("REFUND") });

export interface ExecutorDeps {
  repo: ExecutionRepo;
  /** Null when PayPal credentials are absent. */
  paypal: PayPalClient | null;
  demoMode: boolean;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
  /**
   * Called after a refund outcome was recorded and counted, so the learning loop (M4) can check
   * whether it is time to propose weight changes. A failure here never changes the result.
   */
  onOutcomeRecorded?: (event: OutcomeRecordedEvent) => Promise<void>;
}

export interface ExecuteContext {
  dispute: Dispute;
  order: Order;
  approval: ApprovalRecord;
  execution: ActionExecution;
  sessionId: string;
}

export type ExecuteResult =
  | { kind: "executed"; execution: ActionExecution; simulated: boolean; outcomeRecorded: boolean }
  | { kind: "already_executed"; execution: ActionExecution }
  /** The live call failed or could not be made. Nothing was marked done; retry with the same request id. */
  | { kind: "failed"; message: string; execution: ActionExecution };

/** The numbers a refund outcome records about the order at the time. */
export function refundSnapshot(dispute: Dispute, order: Order, activeWeightsId: string | null): RefundOutcomeInput {
  return {
    riskScoreSnapshot: dispute.riskScoreSnapshot ?? order.riskScore ?? 0,
    verdictSnapshot: order.verdict ?? "ship",
    winProbabilitySnapshot: dispute.winProbability ?? dispute.baseWinProbability ?? 0,
    signalWeightsId: order.weightsId ?? activeWeightsId,
  };
}

export async function executeApproved(ctx: ExecuteContext, deps: ExecutorDeps): Promise<ExecuteResult> {
  const { dispute, approval, execution } = ctx;
  if (execution.executedAt) return { kind: "already_executed", execution };

  const started = Date.now();
  const simulate = shouldSimulateWrite(dispute, deps.demoMode);
  const action = execution.actionType as DisputeActionType;

  const log = async (status: ActivityMeta["status"], outputSummary: string) => {
    try {
      await deps.log?.({
        sessionId: ctx.sessionId,
        refDisputeId: dispute.id,
        refOrderId: ctx.order.id,
        stepType: "paypal_api",
        toolName: action,
        inputSummary: `${simulate ? "simulate" : "send"} ${action} for dispute ${dispute.id.slice(0, 8)}`,
        outputSummary,
        durationMs: Date.now() - started,
        status,
      });
    } catch {
      /* logging is best effort */
    }
  };
  const failed = async (message: string): Promise<ExecuteResult> => {
    await log("error", message);
    return { kind: "failed", message, execution };
  };

  // The one function that reaches PayPal (or simulates it). It is only ever called by the gate.
  const execute = async (call: PayPalDisputeWrite): Promise<Record<string, unknown>> => {
    if (simulate) return { simulated: true };
    if (!deps.paypal) throw new PayPalError("PayPal credentials are not configured, so the action could not be sent");
    if (!dispute.paypalDisputeId) throw new PayPalError("This dispute is not linked to a PayPal dispute, so the action could not be sent");
    return performLiveDisputeWrite(deps.paypal, dispute.paypalDisputeId, call, execution.paypalRequestId);
  };
  const gate = { lookupApproval: async (id: string) => toLite(await deps.repo.findApprovalById(id)), execute };

  let response: Record<string, unknown>;
  try {
    if (action === "submit_evidence") {
      const body = ProvideEvidenceSchema.safeParse(execution.approvedPayload);
      if (!body.success) return await failed("The stored evidence payload is not valid, so nothing was sent.");
      response = (await submitEvidence(dispute.id, body.data, approval.id, gate)) as Record<string, unknown>;
    } else {
      const body = AcceptClaimSchema.safeParse(execution.approvedPayload);
      if (!body.success) return await failed("The stored accept-claim payload is not valid, so nothing was sent.");
      response = (await acceptClaim(dispute.id, body.data.note, approval.id, gate)) as Record<string, unknown>;
    }
  } catch (err) {
    // A PayPal failure is expected and retryable. Anything else (including a blocked, unapproved
    // write) is a bug or an attack and must not be disguised as a retryable error.
    if (err instanceof PayPalError) return await failed(err.message);
    throw err;
  }

  const executedAt = (deps.now ?? (() => new Date()))().toISOString();
  const refundOutcome = action === "accept_claim" ? refundSnapshot(dispute, ctx.order, await deps.repo.getActiveWeightsId()) : undefined;
  const done = await deps.repo.completeExecution({
    executionId: execution.id,
    disputeId: dispute.id,
    actionType: action,
    isSimulated: simulate,
    paypalResponse: response,
    executedAt,
    ...(refundOutcome ? { refundOutcome } : {}),
  });

  if (!done.applied || !done.execution) {
    // Another request completed it between our check and our write: report what is stored.
    const current = (await deps.repo.getExecutionByApproval(approval.id)) ?? execution;
    return { kind: "already_executed", execution: current };
  }

  await log(simulate ? "simulated" : "success", simulate ? `simulated ${action}; nothing was sent to PayPal` : `${action} accepted by PayPal`);
  if (done.outcomeRecorded) {
    try {
      await deps.onOutcomeRecorded?.({ sessionId: ctx.sessionId, disputeId: dispute.id, counterAfter: done.counterAfter });
    } catch {
      /* the learning-loop check must never change the result */
    }
  }
  return { kind: "executed", execution: done.execution, simulated: simulate, outcomeRecorded: done.outcomeRecorded };
}

function toLite(record: ApprovalRecord | null) {
  return record ? { id: record.id, disputeId: record.disputeId, actionType: record.actionType, decision: record.decision } : null;
}
