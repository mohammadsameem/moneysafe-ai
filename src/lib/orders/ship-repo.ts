import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { evidenceArtefacts, orders } from "@/db/schema";
import { createDrizzleReadRepo } from "./queries";
import type { ShipmentRepo } from "./ship";

export function createDrizzleShipmentRepo(db: Db = getDb()): ShipmentRepo {
  const read = createDrizzleReadRepo(db);
  return {
    findVisibleOrder: (orderId, sessionId) => read.findVisible(orderId, sessionId),
    async completeShipment(orderId, rows, completeness) {
      return db.transaction(async (tx) => {
        const moved = await tx
          .update(orders)
          .set({ status: "shipped", evidenceCompleteness: completeness })
          .where(and(eq(orders.id, orderId), eq(orders.status, "captured")))
          .returning({ id: orders.id });
        if (moved.length === 0) return false; // not captured any more: write nothing
        if (rows.length > 0) await tx.insert(evidenceArtefacts).values(rows);
        return true;
      });
    },
  };
}
