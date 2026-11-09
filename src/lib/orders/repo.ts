/**
 * Drizzle implementation of OrdersRepo. Thin on purpose: every rule lives in service.ts, so the
 * rules are testable with an in-memory fake and this file only has to run the queries.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { orders, settings, signalWeights, type NewOrder } from "@/db/schema";
import type { OrdersRepo, OrderStatus } from "./types";
import { toSignalWeightValues } from "./weights";

export function createDrizzleOrdersRepo(db: Db = getDb()): OrdersRepo {
  const one = async <T>(rows: Promise<T[]>): Promise<T | null> => (await rows)[0] ?? null;

  return {
    async getBaselineAvgUsd() {
      const row = await one(db.select({ value: settings.merchantAvgOrderValueUsd }).from(settings).limit(1));
      if (!row) throw new Error("settings row is missing; run npm run db:seed");
      return row.value;
    },

    async getActiveWeights() {
      const row = await one(db.select().from(signalWeights).where(eq(signalWeights.isActive, true)).limit(1));
      if (!row) throw new Error("no active signal_weights row; run npm run db:seed");
      return { id: row.id, values: toSignalWeightValues(row) };
    },

    async hasEarlierPaidOrder(email, excludeOrderId) {
      const paid: OrderStatus[] = ["captured", "shipped"];
      const row = await one(
        db
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(
              sql`lower(${orders.buyerEmail}) = ${email.trim().toLowerCase()}`,
              inArray(orders.status, paid),
              ne(orders.id, excludeOrderId),
            ),
          )
          .limit(1),
      );
      return row !== null;
    },

    async insertOrder(row: NewOrder) {
      const inserted = await one(db.insert(orders).values(row).returning());
      if (!inserted) throw new Error("order insert returned no row");
      return inserted;
    },

    findById: (id) => one(db.select().from(orders).where(eq(orders.id, id)).limit(1)),

    findByPayPalOrderId: (paypalOrderId) =>
      one(db.select().from(orders).where(eq(orders.paypalOrderId, paypalOrderId)).limit(1)),

    async updateOrder(id, patch) {
      const updated = await one(db.update(orders).set(patch).where(eq(orders.id, id)).returning());
      if (!updated) throw new Error("order to update does not exist");
      return updated;
    },

    transitionStatus: (id, from, patch) =>
      one(
        db
          .update(orders)
          .set(patch)
          .where(and(eq(orders.id, id), eq(orders.status, from)))
          .returning(),
      ),
  };
}
