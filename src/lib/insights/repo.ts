/**
 * Drizzle implementation of the learning-loop store. Thin on purpose: every rule lives in loop.ts,
 * decide.ts and summary.ts, which are tested against an in-memory fake with the same semantics.
 */
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { disputeOutcomes, disputes, insightsCache, orders, signalWeights } from "@/db/schema";
import type { SignalName } from "@/lib/scoring";
import { seedId } from "@/seed/ids";
import type { InsightsRepo, OutcomeForProposal, OutcomeStats } from "./types";

/** The single insights_cache row. Same id the seed writes, so the seed and the app update one row. */
export const INSIGHTS_CACHE_ID = seedId("insights", "main");

export function createDrizzleInsightsRepo(db: Db = getDb()): InsightsRepo {
  const activeWeights = async () => {
    const rows = await db.select().from(signalWeights).where(eq(signalWeights.isActive, true)).limit(1);
    return rows[0] ?? null;
  };

  return {
    getActiveWeights: activeWeights,

    async getOutcomeStats(): Promise<OutcomeStats> {
      const groups = await db
        .select({
          outcome: disputeOutcomes.outcome,
          simulated: disputeOutcomes.isSimulated,
          seeded: disputes.isSeed,
          n: sql<number>`count(*)::int`,
        })
        .from(disputeOutcomes)
        .innerJoin(disputes, eq(disputeOutcomes.disputeId, disputes.id))
        .groupBy(disputeOutcomes.outcome, disputeOutcomes.isSimulated, disputes.isSeed);
      const latest = await db.select({ id: disputeOutcomes.id }).from(disputeOutcomes).orderBy(desc(disputeOutcomes.createdAt), desc(disputeOutcomes.id)).limit(1);

      const stats: OutcomeStats = { total: 0, won: 0, lost: 0, refunded: 0, simulated: 0, seeded: 0, latestOutcomeId: latest[0]?.id ?? null };
      for (const g of groups) {
        stats.total += g.n;
        stats[g.outcome] += g.n;
        if (g.simulated) stats.simulated += g.n;
        if (g.seeded) stats.seeded += g.n;
      }
      return stats;
    },

    async listRecentOutcomes(limit): Promise<OutcomeForProposal[]> {
      const rows = await db
        .select({
          outcome: disputeOutcomes.outcome,
          isSimulated: disputeOutcomes.isSimulated,
          createdAt: disputeOutcomes.createdAt,
          riskScore: disputeOutcomes.riskScoreSnapshot,
          verdict: disputeOutcomes.verdictSnapshot,
          winProbability: disputeOutcomes.winProbabilitySnapshot,
          reason: disputes.reason,
          amountUsd: disputes.disputedAmountUsd,
          breakdown: orders.signalBreakdown,
        })
        .from(disputeOutcomes)
        .innerJoin(disputes, eq(disputeOutcomes.disputeId, disputes.id))
        .innerJoin(orders, eq(disputes.orderId, orders.id))
        .orderBy(desc(disputeOutcomes.createdAt), desc(disputeOutcomes.id))
        .limit(limit);
      return rows.map((r) => ({
        outcome: r.outcome,
        reason: r.reason,
        amountUsd: r.amountUsd,
        riskScore: r.riskScore,
        verdict: r.verdict,
        winProbability: r.winProbability,
        activeSignals: (r.breakdown ?? []).filter((s) => s.active).map((s) => s.signal as SignalName),
        isSimulated: r.isSimulated,
        createdAt: r.createdAt,
      }));
    },

    async storeProposal({ weightsId, proposed, reasoning, createdAt }) {
      // One statement: the proposal is stored only if none is pending, and the counter resets with it.
      const rows = await db
        .update(signalWeights)
        .set({
          proposedCountryMismatch: proposed.country_mismatch,
          proposedFirstTimeHighValue: proposed.first_time_high_value,
          proposedRushShipping: proposed.rush_shipping,
          proposedHighRelativeValue: proposed.high_relative_value,
          proposedDisposableEmail: proposed.disposable_email,
          proposedRepeatedAttempts: proposed.repeated_attempts,
          proposalReasoning: reasoning,
          proposalCreatedAt: createdAt,
          resolvedSinceLastProposal: 0,
        })
        .where(and(eq(signalWeights.id, weightsId), eq(signalWeights.isActive, true), isNull(signalWeights.proposalCreatedAt)))
        .returning({ id: signalWeights.id });
      return rows.length > 0;
    },

    async resetCounter(weightsId) {
      await db.update(signalWeights).set({ resolvedSinceLastProposal: 0 }).where(eq(signalWeights.id, weightsId));
    },

    async applyProposal(weightsId, proposalCreatedAt) {
      const rows = await db
        .update(signalWeights)
        .set({
          countryMismatch: sql`${signalWeights.proposedCountryMismatch}`,
          firstTimeHighValue: sql`${signalWeights.proposedFirstTimeHighValue}`,
          rushShipping: sql`${signalWeights.proposedRushShipping}`,
          highRelativeValue: sql`${signalWeights.proposedHighRelativeValue}`,
          disposableEmail: sql`${signalWeights.proposedDisposableEmail}`,
          repeatedAttempts: sql`${signalWeights.proposedRepeatedAttempts}`,
          proposedCountryMismatch: null,
          proposedFirstTimeHighValue: null,
          proposedRushShipping: null,
          proposedHighRelativeValue: null,
          proposedDisposableEmail: null,
          proposedRepeatedAttempts: null,
          proposalReasoning: null,
          proposalCreatedAt: null,
          resolvedSinceLastProposal: 0,
        })
        .where(
          and(
            eq(signalWeights.id, weightsId),
            eq(signalWeights.isActive, true),
            eq(signalWeights.proposalCreatedAt, proposalCreatedAt),
            // A half-written proposal can never be applied: every proposed value must exist.
            isNotNull(signalWeights.proposedCountryMismatch),
            isNotNull(signalWeights.proposedFirstTimeHighValue),
            isNotNull(signalWeights.proposedRushShipping),
            isNotNull(signalWeights.proposedHighRelativeValue),
            isNotNull(signalWeights.proposedDisposableEmail),
            isNotNull(signalWeights.proposedRepeatedAttempts),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async rejectProposal(weightsId, proposalCreatedAt) {
      const rows = await db
        .update(signalWeights)
        .set({
          proposedCountryMismatch: null,
          proposedFirstTimeHighValue: null,
          proposedRushShipping: null,
          proposedHighRelativeValue: null,
          proposedDisposableEmail: null,
          proposedRepeatedAttempts: null,
          proposalReasoning: null,
          proposalCreatedAt: null,
          // The counter keeps its value on rejection (design 7.4).
        })
        .where(and(eq(signalWeights.id, weightsId), eq(signalWeights.isActive, true), eq(signalWeights.proposalCreatedAt, proposalCreatedAt)))
        .returning();
      return rows[0] ?? null;
    },

    async getCache() {
      const rows = await db.select().from(insightsCache).where(eq(insightsCache.id, INSIGHTS_CACHE_ID)).limit(1);
      return rows[0] ?? null;
    },

    async upsertCache(row) {
      const values = { id: INSIGHTS_CACHE_ID, ...row };
      await db
        .insert(insightsCache)
        .values(values)
        .onConflictDoUpdate({ target: insightsCache.id, set: { summary: row.summary, usedFallback: row.usedFallback, inputFingerprint: row.inputFingerprint, generatedAt: row.generatedAt } });
    },
  };
}
