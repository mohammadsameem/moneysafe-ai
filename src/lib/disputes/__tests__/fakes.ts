import type { Dispute, EvidenceArtefact } from "@/db/schema";
import { makeOrder } from "@/lib/orders/__tests__/fakes";
import type { AnalysisPatch, DisputeRecord, DisputesAnalysisRepo, DisputesReadRepo } from "../types";

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
  saves: AnalysisPatch[];
  /** Make the next saveAnalysis lose the race: another request saved `winner` first. */
  loseNextSave(winner: AnalysisPatch): void;
}

export function createFakeAnalysisRepo(records: DisputeRecord[], artefacts: EvidenceArtefact[] = []): FakeAnalysisRepo {
  const read = createFakeReadRepo(records, artefacts);
  const saves: AnalysisPatch[] = [];
  let winner: AnalysisPatch | null = null;

  const apply = (id: string, patch: AnalysisPatch): Dispute | null => {
    const i = records.findIndex((r) => r.dispute.id === id);
    const current = records[i];
    if (!current || current.dispute.analysisComputedAt !== null) return null; // WHERE analysis_computed_at IS NULL
    const updated = { ...current.dispute, ...patch } as Dispute;
    records[i] = { ...current, dispute: updated };
    return updated;
  };

  return {
    ...read,
    records,
    saves,
    loseNextSave: (w) => {
      winner = w;
    },
    async saveAnalysis(id, patch) {
      saves.push(patch);
      if (winner) {
        const w = winner;
        winner = null;
        apply(id, w); // the other request got there first
        return null;
      }
      return apply(id, patch);
    },
  };
}
