/**
 * Read side of the orders API (M1-10).
 *
 * Visibility: an order is visible to a session when it is seeded (shared demo data) or was
 * created in that session. Another session's orders do not exist as far as the caller can tell.
 */
import { desc, eq, or } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { orders, type Order, type SignalBreakdownItem, type VerificationDraft } from "@/db/schema";

export const MAX_LIST_ROWS = 200;

export interface OrderSummary {
  id: string;
  buyerEmail: string;
  amountUsd: number;
  currency: string;
  status: Order["status"];
  riskScore: number | null;
  verdict: Order["verdict"];
  /** True for seeded and demo orders: the UI shows the "Demo data" badge (REQ-DEMO-07). */
  isDemo: boolean;
  usedFallback: boolean;
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  shippingMethod: Order["shippingMethod"];
  billingCountry: string;
  shippingCountry: string;
  buyerIsFirstTime: boolean;
  paymentAttemptCount: number;
  aiExplanation: string | null;
  verificationDraft: VerificationDraft | null;
  evidenceCompleteness: number | null;
  signalBreakdown: SignalBreakdownItem[];
}

export function toOrderSummary(o: Order): OrderSummary {
  return {
    id: o.id,
    buyerEmail: o.buyerEmail,
    amountUsd: o.amountUsd,
    currency: o.currency,
    status: o.status,
    riskScore: o.riskScore,
    verdict: o.verdict,
    isDemo: o.isDemo || o.isSeed,
    usedFallback: o.usedFallback,
    createdAt: o.createdAt,
  };
}

export function toOrderDetail(o: Order): OrderDetail {
  return {
    ...toOrderSummary(o),
    shippingMethod: o.shippingMethod,
    billingCountry: o.billingCountry,
    shippingCountry: o.shippingCountry,
    buyerIsFirstTime: o.buyerIsFirstTime,
    paymentAttemptCount: o.paymentAttemptCount,
    aiExplanation: o.aiExplanation,
    verificationDraft: o.verificationDraft,
    evidenceCompleteness: o.evidenceCompleteness,
    signalBreakdown: o.signalBreakdown ?? [],
  };
}

export interface OrdersReadRepo {
  listVisible(sessionId: string): Promise<Order[]>;
  findVisible(id: string, sessionId: string): Promise<Order | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

export function createDrizzleReadRepo(db: Db = getDb()): OrdersReadRepo {
  const visible = (sessionId: string) => or(eq(orders.isSeed, true), eq(orders.sessionId, sessionId));
  return {
    listVisible: (sessionId) =>
      db.select().from(orders).where(visible(sessionId)).orderBy(desc(orders.createdAt)).limit(MAX_LIST_ROWS),
    async findVisible(id, sessionId) {
      if (!isUuid(id)) return null; // a malformed id is "not found", not a database error
      const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      const row = rows[0];
      return row && (row.isSeed || row.sessionId === sessionId) ? row : null;
    },
  };
}
