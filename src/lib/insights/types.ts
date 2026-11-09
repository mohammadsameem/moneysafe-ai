import type { Dispute, InsightsCacheRow, SignalWeights } from "@/db/schema";
import type { SignalName, SignalWeightValues, Verdict } from "@/lib/scoring";

/** What the learning loop knows about one resolved dispute. Contains no buyer details. */
export interface OutcomeForProposal {
  outcome: "won" | "lost" | "refunded";
  reason: Dispute["reason"];
  amountUsd: number;
  riskScore: number;
  verdict: Verdict;
  winProbability: number;
  /** The risk signals that fired on the order when it was scored. */
  activeSignals: SignalName[];
  isSimulated: boolean;
  createdAt: string;
}

export interface OutcomeStats {
  total: number;
  won: number;
  lost: number;
  refunded: number;
  /** Outcomes recorded by Simulate outcome (or a simulated refund). */
  simulated: number;
  /** Outcomes of seeded history (H1-H5). */
  seeded: number;
  latestOutcomeId: string | null;
}

/** Everything the summary needs. */
export interface InsightsSummaryInput {
  stats: OutcomeStats;
  current: SignalWeightValues;
  proposed: SignalWeightValues | null;
  /** signal_weights.resolved_since_last_proposal */
  counter: number;
  recent: readonly OutcomeForProposal[];
}

export interface NewInsightsCache {
  summary: string;
  usedFallback: boolean;
  inputFingerprint: string;
  generatedAt: string;
}

export interface StoreProposalInput {
  weightsId: string;
  proposed: SignalWeightValues;
  reasoning: string;
  createdAt: string;
}

/** Persistence for the learning loop and the Insights page. Drizzle implementation in ./repo. */
export interface InsightsRepo {
  getActiveWeights(): Promise<SignalWeights | null>;
  getOutcomeStats(): Promise<OutcomeStats>;
  /** Newest first. */
  listRecentOutcomes(limit: number): Promise<OutcomeForProposal[]>;
  /**
   * Store a pending proposal and reset the counter to 0, in one statement, only if no proposal is
   * pending. False means one was already pending (nothing changed).
   */
  storeProposal(input: StoreProposalInput): Promise<boolean>;
  /** Reset the counter without storing a proposal (the model saw no reason to change anything). */
  resetCounter(weightsId: string): Promise<void>;
  /**
   * Approve: active weights <- proposed, clear the proposal, counter <- 0. Only if the pending
   * proposal is the one created at `proposalCreatedAt`. Returns the updated row, or null.
   */
  applyProposal(weightsId: string, proposalCreatedAt: string): Promise<SignalWeights | null>;
  /** Reject: clear the proposal. The counter is NOT reset. Same guard as applyProposal. */
  rejectProposal(weightsId: string, proposalCreatedAt: string): Promise<SignalWeights | null>;
  getCache(): Promise<InsightsCacheRow | null>;
  upsertCache(row: NewInsightsCache): Promise<void>;
}
