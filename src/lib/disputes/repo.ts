/**
 * Drizzle implementation of the disputes stores. Thin on purpose: every rule lives in the service
 * modules, which are tested against an in-memory fake with the same semantics.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { disputes, evidenceArtefacts, orders } from "@/db/schema";
import { isUuid } from "@/lib/orders/queries";
import type { AnalysisPatch, DisputeRecord, DisputesAnalysisRepo } from "./types";

export function createDrizzleDisputesRepo(db: Db = getDb()): DisputesAnalysisRepo {
  const joined = () => db.select({ dispute: disputes, order: orders }).from(disputes).innerJoin(orders, eq(disputes.orderId, orders.id));
  const visible = (sessionId: string) => or(eq(disputes.isSeed, true), eq(disputes.sessionId, sessionId));

  return {
    async listVisible(sessionId) {
      const rows: DisputeRecord[] = await joined().where(visible(sessionId));
      return rows;
    },
    async findVisible(id, sessionId) {
      if (!isUuid(id)) return null; // a malformed id is "not found", not a database error
      const rows: DisputeRecord[] = await joined().where(and(eq(disputes.id, id), visible(sessionId))).limit(1);
      return rows[0] ?? null;
    },
    getArtefacts: (orderId) => db.select().from(evidenceArtefacts).where(eq(evidenceArtefacts.orderId, orderId)),

    async saveAnalysis(id, patch: AnalysisPatch) {
      const rows = await db
        .update(disputes)
        .set(patch)
        .where(and(eq(disputes.id, id), isNull(disputes.analysisComputedAt)))
        .returning();
      return rows[0] ?? null;
    },
  };
}

/** The read-only view of the same repo (kept for callers that only list and open disputes). */
export const createDrizzleDisputesReadRepo = createDrizzleDisputesRepo;
