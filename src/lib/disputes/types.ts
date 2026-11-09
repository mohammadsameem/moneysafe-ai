import type { ActionExecution, ApprovalRecord, Dispute, EvidenceArtefact, Order } from "@/db/schema";

/** A dispute with the order it belongs to (every dispute has exactly one). */
export interface DisputeRecord {
  dispute: Dispute;
  order: Order;
}

/**
 * Read side of the disputes store. Visibility rule: a dispute is visible to a session when it is
 * seeded (shared demo data) or was created in that session. Anything else looks like it does not
 * exist, so ids cannot be probed.
 */
export interface DisputesReadRepo {
  listVisible(sessionId: string): Promise<DisputeRecord[]>;
  findVisible(id: string, sessionId: string): Promise<DisputeRecord | null>;
  getArtefacts(orderId: string): Promise<EvidenceArtefact[]>;
}

/** Everything the analysis step writes onto a dispute row (design 7.3). */
export interface AnalysisPatch {
  baseWinProbability: number;
  /** Null (with winProbability and the label) when the AI step was unavailable. */
  llmAdjustment: number | null;
  winProbability: number | null;
  winLikelihoodLabel: Dispute["winLikelihoodLabel"];
  systemRecommendation: NonNullable<Dispute["systemRecommendation"]>;
  overrideRecommendation: Dispute["overrideRecommendation"];
  finalRecommendation: NonNullable<Dispute["finalRecommendation"]>;
  recommendationSource: NonNullable<Dispute["recommendationSource"]>;
  reasoning: string;
  evidenceUsed: string[];
  evidenceGaps: string[];
  draftResponse: string | null;
  analysisComputedAt: string;
  riskScoreSnapshot: number | null;
}

export interface DisputesAnalysisRepo extends DisputesReadRepo {
  /**
   * Atomically CLAIM the dispute for analysis: write `token` into `analysis_computed_at` only if it
   * is null, or holds a claim older than `staleBeforeIso`. Returns true for exactly one caller.
   */
  claimAnalysis(id: string, token: string, staleBeforeIso: string): Promise<boolean>;
  /**
   * Replace the claim with the finished analysis (`patch.analysisComputedAt` is the real
   * timestamp). Only succeeds while `token` is still the stored claim; returns the updated row, or
   * null if the claim was lost (taken over as stale).
   */
  saveAnalysis(id: string, patch: AnalysisPatch, token: string): Promise<Dispute | null>;
  /** Give the claim back (set it to null) if `token` is still the stored claim. */
  releaseAnalysisClaim(id: string, token: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Approvals and executions (M2-04, M2-05)
// ---------------------------------------------------------------------------
export type DisputeActionType = "submit_evidence" | "accept_claim";

/**
 * Thrown by `insertApprovalWithExecution` when the partial unique index rejects a second APPROVED
 * record for the same (dispute, action): another request approved first. The caller re-reads the
 * state and continues from there; it never inserts a second execution.
 */
export class ApprovalConflictError extends Error {
  constructor() {
    super("an approved record already exists for this dispute and action");
    this.name = "ApprovalConflictError";
  }
}

export interface NewApprovalWithExecution {
  disputeId: string;
  actionType: DisputeActionType;
  merchantUserId: string;
  /** SHA-256 of the action payload (REQ-DIS-06). */
  payloadHash: string;
  /** The body that is (or would be) sent to PayPal. */
  approvedPayload: Record<string, unknown>;
  /** The draft as the system wrote it, and the merchant's edited version (null if not edited). */
  originalDraft: string | null;
  editedDraft: string | null;
  /** Sent as the PayPal-Request-Id header; generated once here and reused unchanged on every retry. */
  paypalRequestId: string;
}

export interface NewRejection {
  disputeId: string;
  actionType: DisputeActionType;
  merchantUserId: string;
  payloadHash: string;
}

/** What a refund outcome row records about the order at the time (REQ-LL-01). */
export interface RefundOutcomeInput {
  riskScoreSnapshot: number;
  verdictSnapshot: "ship" | "verify" | "hold";
  winProbabilitySnapshot: number;
  signalWeightsId: string | null;
}

export interface CompleteExecutionInput {
  executionId: string;
  disputeId: string;
  actionType: DisputeActionType;
  isSimulated: boolean;
  paypalResponse: Record<string, unknown>;
  executedAt: string;
  /** Required for accept_claim. */
  refundOutcome?: RefundOutcomeInput;
}

export interface CompleteExecutionResult {
  /** False when the execution was already completed (another request got there first); nothing changed. */
  applied: boolean;
  execution: ActionExecution | null;
  /** True only when THIS call inserted the dispute_outcomes row and bumped the counter. */
  outcomeRecorded: boolean;
  /**
   * `resolved_since_last_proposal` right after THIS call's bump (UPDATE ... RETURNING), or null
   * when this call did not count an outcome. The learning loop keys its "every 5th" check on it.
   */
  counterAfter: number | null;
}

/** Passed to the learning-loop hook after an outcome row was inserted and counted. */
export interface OutcomeRecordedEvent {
  sessionId: string;
  disputeId: string;
  counterAfter: number | null;
}

export interface ExecutionRepo {
  findApprovalById(id: string): Promise<ApprovalRecord | null>;
  getExecutionByApproval(approvalRecordId: string): Promise<ActionExecution | null>;
  getActiveWeightsId(): Promise<string | null>;
  /**
   * ONE transaction: mark the execution done (only if it is not already), and then
   *   submit_evidence -> dispute status "action_taken";
   *   accept_claim    -> dispute "resolved_refunded" + outcome "refunded", insert the
   *                      dispute_outcomes row (ON CONFLICT DO NOTHING) and bump
   *                      `signal_weights.resolved_since_last_proposal` only if that row was inserted.
   */
  completeExecution(input: CompleteExecutionInput): Promise<CompleteExecutionResult>;
}

export interface ActionHistory {
  /** Oldest first, approvals and rejections. */
  approvals: ApprovalRecord[];
  /** Oldest first. */
  executions: ActionExecution[];
}

export interface ApprovalsRepo extends ExecutionRepo {
  findApprovedApproval(disputeId: string, actionType: DisputeActionType): Promise<ApprovalRecord | null>;
  /** Every approval/rejection and execution for one dispute (for the timeline and the panel). */
  getActionHistory(disputeId: string): Promise<ActionHistory>;
  /** Insert the approval and its (unexecuted) execution in ONE transaction. Throws ApprovalConflictError. */
  insertApprovalWithExecution(input: NewApprovalWithExecution): Promise<{ approval: ApprovalRecord; execution: ActionExecution }>;
  insertRejection(input: NewRejection): Promise<ApprovalRecord>;
}

export interface DisputesRepo extends DisputesAnalysisRepo, ApprovalsRepo {}
