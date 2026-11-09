import { randomUUID } from "node:crypto";
import type { ActionExecution, ApprovalRecord, Dispute, EvidenceArtefact } from "@/db/schema";
import { makeOrder } from "@/lib/orders/__tests__/fakes";
import {
  ApprovalConflictError,
  type AnalysisPatch,
  type DisputeRecord,
  type DisputesAnalysisRepo,
  type DisputesReadRepo,
  type DisputesRepo,
  type NewApprovalWithExecution,
} from "../types";

export const NOW = new Date("2026-11-08T12:00:00.000Z");
export const SESSION = "session-a";
export const OTHER_SESSION = "session-b";
export const DISPUTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ISO = "2026-11-07T12:00:00.000Z";

/** A complete dispute row with safe defaults. */
export function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: DISPUTE_ID,
    paypalDisputeId: null,
    orderId: ORDER_ID,
    reason: "item_not_received",
    buyerMessage: "It never arrived.",
    disputedAmountUsd: 145,
    deadlineOffsetHours: null,
    deadlineAt: "2026-11-12T12:00:00.000Z",
    status: "open",
    outcome: null,
    outcomeIsSimulated: false,
    baseWinProbability: null,
    llmAdjustment: null,
    winProbability: null,
    winLikelihoodLabel: null,
    systemRecommendation: null,
    overrideRecommendation: null,
    finalRecommendation: null,
    recommendationSource: null,
    reasoning: null,
    evidenceUsed: null,
    evidenceGaps: null,
    draftResponse: null,
    analysisComputedAt: null,
    riskScoreSnapshot: null,
    sessionId: SESSION,
    isSeed: false,
    isDemo: true,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

/** A dispute that already has a stored analysis (as every seeded open dispute does). */
export function analysed(overrides: Partial<Dispute> = {}): Dispute {
  return makeDispute({
    baseWinProbability: 1,
    llmAdjustment: 0,
    winProbability: 0.95,
    winLikelihoodLabel: "Strong",
    systemRecommendation: "contest",
    finalRecommendation: "contest",
    recommendationSource: "system",
    reasoning: "Complete evidence.",
    evidenceUsed: ["Invoice / order summary"],
    evidenceGaps: [],
    draftResponse: "Hello PayPal Dispute Team,\n\nThe parcel was delivered.\n\n[Your name]",
    analysisComputedAt: ISO,
    riskScoreSnapshot: 0,
    ...overrides,
  });
}

export function makeRecord(dispute: Dispute = makeDispute(), orderOverrides: Parameters<typeof makeOrder>[0] = {}): DisputeRecord {
  return {
    dispute,
    order: makeOrder({ id: dispute.orderId, status: "shipped", riskScore: 0, verdict: "ship", amountUsd: dispute.disputedAmountUsd, ...orderOverrides }),
  };
}

export function createFakeReadRepo(records: DisputeRecord[], artefacts: EvidenceArtefact[] = []): DisputesReadRepo {
  const visible = (r: DisputeRecord, sessionId: string) => r.dispute.isSeed || r.dispute.sessionId === sessionId;
  return {
    listVisible: async (sessionId) => records.filter((r) => visible(r, sessionId)),
    findVisible: async (id, sessionId) => records.find((r) => r.dispute.id === id && visible(r, sessionId)) ?? null,
    getArtefacts: async (orderId) => artefacts.filter((a) => a.orderId === orderId),
  };
}

// ---------------------------------------------------------------------------
// Writable fake: mirrors the SQL semantics the services rely on.
// ---------------------------------------------------------------------------
export interface FakeAnalysisRepo extends DisputesAnalysisRepo {
  records: DisputeRecord[];
  /** Every patch passed to saveAnalysis (whether or not it was applied). */
  saves: AnalysisPatch[];
  /** Number of claimAnalysis calls that won. */
  claimsWon: number;
  /** Number of claimAnalysis calls that lost. */
  claimsLost: number;
  releases: number;
  /** The next saveAnalysis finds its claim already taken over: `winner` was saved by someone else. */
  loseNextSave(winner: AnalysisPatch): void;
}

export function createFakeAnalysisRepo(records: DisputeRecord[], artefacts: EvidenceArtefact[] = []): FakeAnalysisRepo {
  const read = createFakeReadRepo(records, artefacts);
  const saves: AnalysisPatch[] = [];
  let winner: AnalysisPatch | null = null;
  const stats = { claimsWon: 0, claimsLost: 0, releases: 0 };

  const indexOf = (id: string) => records.findIndex((r) => r.dispute.id === id);
  const setMarker = (id: string, patch: Partial<Dispute>) => {
    const i = indexOf(id);
    const current = records[i];
    if (current) records[i] = { ...current, dispute: { ...current.dispute, ...patch } as Dispute };
  };

  const repo: FakeAnalysisRepo = {
    ...read,
    records,
    saves,
    get claimsWon() {
      return stats.claimsWon;
    },
    get claimsLost() {
      return stats.claimsLost;
    },
    get releases() {
      return stats.releases;
    },
    loseNextSave: (w) => {
      winner = w;
    },

    // One synchronous step, like the single UPDATE ... WHERE it mirrors: only one caller can win.
    async claimAnalysis(id, token, staleBeforeIso) {
      const current = records[indexOf(id)]?.dispute;
      const marker = current?.analysisComputedAt ?? null;
      const free = marker === null;
      const time = marker?.slice(8, 32) ?? "";
      const stale = marker !== null && marker.startsWith("pending:") && (time < staleBeforeIso || !/^\d{4}-\d{2}-\d{2}T/.test(time));
      if (!current || !(free || stale)) {
        stats.claimsLost += 1;
        return false;
      }
      setMarker(id, { analysisComputedAt: token });
      stats.claimsWon += 1;
      return true;
    },

    async saveAnalysis(id, patch, token) {
      saves.push(patch);
      if (winner) {
        const w = winner;
        winner = null;
        setMarker(id, { ...w }); // someone else took the claim over and finished
        return null;
      }
      const current = records[indexOf(id)]?.dispute;
      if (!current || current.analysisComputedAt !== token) return null; // WHERE analysis_computed_at = token
      setMarker(id, { ...patch });
      return records[indexOf(id)]!.dispute;
    },

    async releaseAnalysisClaim(id, token) {
      stats.releases += 1;
      if (records[indexOf(id)]?.dispute.analysisComputedAt === token) setMarker(id, { analysisComputedAt: null });
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// The whole persistence contract, in memory (M2-04 / M2-05 tests).
// ---------------------------------------------------------------------------
export interface FakeOutcomeRow {
  disputeId: string;
  outcome: "refunded";
  riskScoreSnapshot: number;
  verdictSnapshot: "ship" | "verify" | "hold";
  winProbabilitySnapshot: number;
  signalWeightsId: string | null;
  isSimulated: boolean;
}

export interface FakeDisputesRepo extends DisputesRepo, FakeAnalysisRepo {
  approvals: ApprovalRecord[];
  executions: ActionExecution[];
  outcomes: FakeOutcomeRow[];
  /** signal_weights.resolved_since_last_proposal on the active row. */
  counter: { value: number };
  /** Rows inserted over the repo's lifetime (an insert that failed is not counted). */
  inserts: { approvals: number; executions: number; rejections: number };
  /** The next insertApprovalWithExecution finds that another request approved first: `rival` is stored, then the unique index fires. */
  raceNextApproval(rival: { executed: boolean }): void;
}

export function createFakeDisputesRepo(records: DisputeRecord[], artefacts: EvidenceArtefact[] = []): FakeDisputesRepo {
  const base = createFakeAnalysisRepo(records, artefacts);
  const approvals: ApprovalRecord[] = [];
  const executions: ActionExecution[] = [];
  const outcomes: FakeOutcomeRow[] = [];
  const counter = { value: 0 };
  const inserts = { approvals: 0, executions: 0, rejections: 0 };
  let rival: { executed: boolean } | null = null;
  const stamp = () => NOW.toISOString();

  const store = (input: NewApprovalWithExecution, rivalRequestId?: string, executed = false) => {
    const approval: ApprovalRecord = {
      id: randomUUID(),
      disputeId: input.disputeId,
      actionType: input.actionType,
      merchantUserId: input.merchantUserId,
      decision: "approved",
      payloadHash: input.payloadHash,
      createdAt: stamp(),
    };
    const execution: ActionExecution = {
      id: randomUUID(),
      approvalRecordId: approval.id,
      disputeId: input.disputeId,
      actionType: input.actionType,
      approvedPayload: input.approvedPayload,
      originalDraft: input.originalDraft,
      editedDraft: input.editedDraft,
      paypalRequestId: rivalRequestId ?? input.paypalRequestId,
      paypalResponse: executed ? { simulated: true } : null,
      executedAt: executed ? stamp() : null,
      isSimulated: executed,
      createdAt: stamp(),
    };
    approvals.push(approval);
    executions.push(execution);
    inserts.approvals += 1;
    inserts.executions += 1;
    return { approval, execution };
  };

  const setDispute = (id: string, patch: Partial<Dispute>) => {
    const i = base.records.findIndex((r) => r.dispute.id === id);
    const current = base.records[i];
    if (current) base.records[i] = { ...current, dispute: { ...current.dispute, ...patch, updatedAt: NOW.toISOString() } };
  };

  return {
    ...base,
    approvals,
    executions,
    outcomes,
    counter,
    inserts,
    raceNextApproval: (r) => {
      rival = r;
    },

    async findApprovalById(id) {
      return approvals.find((a) => a.id === id) ?? null;
    },
    async findApprovedApproval(disputeId, actionType) {
      return approvals.find((a) => a.disputeId === disputeId && a.actionType === actionType && a.decision === "approved") ?? null;
    },
    async getExecutionByApproval(approvalRecordId) {
      return executions.find((e) => e.approvalRecordId === approvalRecordId) ?? null;
    },
    async getActiveWeightsId() {
      return "active-weights-id";
    },

    async insertApprovalWithExecution(input) {
      const exists = () => approvals.some((a) => a.disputeId === input.disputeId && a.actionType === input.actionType && a.decision === "approved");
      if (rival) {
        const r = rival;
        rival = null;
        store(input, randomUUID(), r.executed); // the other request's rows
        throw new ApprovalConflictError();
      }
      if (exists()) throw new ApprovalConflictError(); // the partial unique index
      return store(input);
    },

    async insertRejection(input) {
      const row: ApprovalRecord = {
        id: randomUUID(),
        disputeId: input.disputeId,
        actionType: input.actionType,
        merchantUserId: input.merchantUserId,
        decision: "rejected",
        payloadHash: input.payloadHash,
        createdAt: stamp(),
      };
      approvals.push(row);
      inserts.rejections += 1;
      return row;
    },

    async completeExecution(input) {
      const i = executions.findIndex((e) => e.id === input.executionId);
      const current = executions[i];
      if (!current || current.executedAt !== null) return { applied: false, execution: null, outcomeRecorded: false }; // WHERE executed_at IS NULL
      const execution: ActionExecution = { ...current, executedAt: input.executedAt, isSimulated: input.isSimulated, paypalResponse: input.paypalResponse };
      executions[i] = execution;

      const record = base.records.find((r) => r.dispute.id === input.disputeId);
      if (input.actionType === "submit_evidence") {
        if (record?.dispute.status === "open") setDispute(input.disputeId, { status: "action_taken" });
        return { applied: true, execution, outcomeRecorded: false };
      }

      if (record && (record.dispute.status === "open" || record.dispute.status === "action_taken")) {
        setDispute(input.disputeId, { status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: input.isSimulated });
      }
      const snapshot = input.refundOutcome;
      if (!snapshot) throw new Error("accept_claim completion needs a refund outcome snapshot");
      const already = outcomes.some((o) => o.disputeId === input.disputeId); // UNIQUE (dispute_id) + ON CONFLICT DO NOTHING
      if (!already) {
        outcomes.push({ disputeId: input.disputeId, outcome: "refunded", ...snapshot, isSimulated: input.isSimulated });
        counter.value += 1;
      }
      return { applied: true, execution, outcomeRecorded: !already };
    },
  };
}
