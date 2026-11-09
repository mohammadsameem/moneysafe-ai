/**
 * Drizzle implementation of the disputes stores. Thin on purpose: every rule lives in the service
 * modules, which are tested against an in-memory fake with the same semantics.
 */
import { and, eq, or } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { disputes, evidenceArtefacts, orders } from "@/db/schema";
import { isUuid } from "@/lib/orders/queries";
import type { DisputeRecord, DisputesReadRepo } from "./types";

export function createDrizzleDisputesReadRepo(db: Db = getDb()): DisputesReadRepo {
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
  };
}
