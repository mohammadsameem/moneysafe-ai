import type { Dispute, EvidenceArtefact, Order } from "@/db/schema";

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
   * Save an analysis only while the dispute has none (`analysis_computed_at IS NULL`). Returns the
   * updated row, or null when another request saved first (the caller then reads that one).
   */
  saveAnalysis(id: string, patch: AnalysisPatch): Promise<Dispute | null>;
}
