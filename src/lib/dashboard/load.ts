/**
 * Loads the dashboard for one session (M4-04). Everything is computed for THIS session's data plus
 * the shared seeded history, the same visibility rule as orders and disputes. No model is called.
 */
import { and, eq, isNotNull, or } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { disputes, orders } from "@/db/schema";
import { listActivity, type ActivityEntry } from "@/lib/activity/queries";
import { getCostAssumptions } from "@/lib/env";
import { computeDashboardMetrics, type DashboardMetrics, type DisputeOutcomeRow, type OrderRow } from "./metrics";

export const RECENT_ACTIVITY_COUNT = 5;

export interface DashboardView extends DashboardMetrics {
  /** The 5 most recent agent activity entries (REQ-DASH-02). */
  recent_activity: ActivityEntry[];
}

export interface DashboardRepo {
  visibleOrders(sessionId: string): Promise<OrderRow[]>;
  /** Disputes with an outcome that this session may see. */
  visibleOutcomes(sessionId: string): Promise<DisputeOutcomeRow[]>;
  recentActivity(sessionId: string, count: number): Promise<ActivityEntry[]>;
}

export function createDrizzleDashboardRepo(db: Db = getDb()): DashboardRepo {
  return {
    visibleOrders: (sessionId) =>
      db
        .select({ amountUsd: orders.amountUsd, verdict: orders.verdict, isSeed: orders.isSeed })
        .from(orders)
        .where(or(eq(orders.isSeed, true), eq(orders.sessionId, sessionId))),
    visibleOutcomes: (sessionId) =>
      db
        .select({ outcome: disputes.outcome, amountUsd: disputes.disputedAmountUsd, simulated: disputes.outcomeIsSimulated, isSeed: disputes.isSeed })
        .from(disputes)
        .where(and(isNotNull(disputes.outcome), or(eq(disputes.isSeed, true), eq(disputes.sessionId, sessionId)))),
    async recentActivity(sessionId, count) {
      return (await listActivity(sessionId, { pageSize: count }, db)).entries;
    },
  };
}

export async function loadDashboard(
  sessionId: string,
  repo: DashboardRepo = createDrizzleDashboardRepo(),
  chargebackFeeUsd: number = getCostAssumptions().chargebackFeeUsd,
): Promise<DashboardView> {
  const [orderRows, outcomeRows, recent] = await Promise.all([repo.visibleOrders(sessionId), repo.visibleOutcomes(sessionId), repo.recentActivity(sessionId, RECENT_ACTIVITY_COUNT)]);
  return { ...computeDashboardMetrics(orderRows, outcomeRows, chargebackFeeUsd), recent_activity: recent };
}
