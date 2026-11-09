/**
 * Drizzle implementation of the reset and restart stores (M4-05). Thin on purpose: the rules
 * (cooldown, order of steps, logging) live in reset.ts and are unit-tested against an in-memory
 * store; the SQL here is exercised against the real database by the live checks.
 */
import { and, count, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { actionExecutions, agentActivity, approvalRecords, disputeOutcomes, disputes, evidenceArtefacts, orders } from "@/db/schema";
import { toActivityRow, type ActivityMeta } from "@/lib/activity/logger";
import { SEED_ACTIVITY_SESSION_ID } from "@/seed/activity";
import { seedInto } from "@/seed/runner";
import { RESET_TOOL_GLOBAL, type RestartStore, type RestartTx, type ResetStore, type ResetTx, type WipeCounts } from "./reset";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Arbitrary constant key for the reset advisory lock. */
const RESET_LOCK_SQL = sql.raw("select pg_advisory_xact_lock(7315042)");

async function insertActivity(tx: Tx, meta: ActivityMeta, createdAt: string): Promise<void> {
  await tx.insert(agentActivity).values({ ...toActivityRow(meta), createdAt });
}

const n = async (query: Promise<{ n: number }[]>): Promise<number> => (await query)[0]?.n ?? 0;

/** Global reset: delete visitor data in foreign-key order. The seed's own rows are re-written by seedInto afterwards. */
async function wipeAll(tx: Tx): Promise<WipeCounts> {
  // Count what a visitor created BEFORE deleting (the seed's own rows are not "removed", they are re-written).
  const nonSeedOrders = tx.select({ id: orders.id }).from(orders).where(eq(orders.isSeed, false));
  const nonSeedDisputes = tx.select({ id: disputes.id }).from(disputes).where(eq(disputes.isSeed, false));
  const counts: WipeCounts = {
    orders: await n(tx.select({ n: count() }).from(orders).where(eq(orders.isSeed, false))),
    evidenceArtefacts: await n(tx.select({ n: count() }).from(evidenceArtefacts).where(inArray(evidenceArtefacts.orderId, nonSeedOrders))),
    disputes: await n(tx.select({ n: count() }).from(disputes).where(eq(disputes.isSeed, false))),
    approvals: await n(tx.select({ n: count() }).from(approvalRecords)),
    executions: await n(tx.select({ n: count() }).from(actionExecutions)),
    outcomes: await n(tx.select({ n: count() }).from(disputeOutcomes).where(inArray(disputeOutcomes.disputeId, nonSeedDisputes))),
    activity: await n(tx.select({ n: count() }).from(agentActivity).where(or(ne(agentActivity.sessionId, SEED_ACTIVITY_SESSION_ID), sql`${agentActivity.sessionId} is null`))),
  };

  // Children before parents. Approvals, executions, outcomes and activity are rebuilt from the seed (it has
  // no approvals or executions), so they are cleared completely; that also removes legacy rows on seed disputes.
  await tx.delete(actionExecutions);
  await tx.delete(approvalRecords);
  await tx.delete(disputeOutcomes);
  await tx.delete(agentActivity);
  await tx.delete(evidenceArtefacts);
  await tx.delete(disputes).where(eq(disputes.isSeed, false));
  await tx.delete(orders).where(eq(orders.isSeed, false));
  return counts;
}

/** Session restart: only rows the caller owns (session_id = caller, never a seed). Children before parents. */
async function wipeSession(tx: Tx, sessionId: string): Promise<WipeCounts> {
  const myDisputes = tx.select({ id: disputes.id }).from(disputes).where(and(eq(disputes.sessionId, sessionId), eq(disputes.isSeed, false)));
  const myOrders = tx.select({ id: orders.id }).from(orders).where(and(eq(orders.sessionId, sessionId), eq(orders.isSeed, false)));

  const executions = await tx.delete(actionExecutions).where(inArray(actionExecutions.disputeId, myDisputes)).returning({ id: actionExecutions.id });
  const approvals = await tx.delete(approvalRecords).where(inArray(approvalRecords.disputeId, myDisputes)).returning({ id: approvalRecords.id });
  const outcomes = await tx.delete(disputeOutcomes).where(inArray(disputeOutcomes.disputeId, myDisputes)).returning({ id: disputeOutcomes.id });
  // Activity: everything this session logged, plus anything that points at its own orders or disputes (so the deletes below
  // cannot be blocked). EXCEPT the global reset's audit row: it is the system's history and the cooldown marker, not session data,
  // so a restart must not erase it (otherwise reset -> restart -> reset would skip the cooldown).
  const activity = await tx
    .delete(agentActivity)
    .where(
      and(
        or(eq(agentActivity.sessionId, sessionId), inArray(agentActivity.refDisputeId, myDisputes), inArray(agentActivity.refOrderId, myOrders)),
        ne(agentActivity.toolName, RESET_TOOL_GLOBAL),
      ),
    )
    .returning({ id: agentActivity.id });
  const artefacts = await tx.delete(evidenceArtefacts).where(inArray(evidenceArtefacts.orderId, myOrders)).returning({ id: evidenceArtefacts.id });
  const removedDisputes = await tx.delete(disputes).where(and(eq(disputes.sessionId, sessionId), eq(disputes.isSeed, false))).returning({ id: disputes.id });
  const removedOrders = await tx.delete(orders).where(and(eq(orders.sessionId, sessionId), eq(orders.isSeed, false))).returning({ id: orders.id });

  return {
    orders: removedOrders.length,
    evidenceArtefacts: artefacts.length,
    disputes: removedDisputes.length,
    approvals: approvals.length,
    executions: executions.length,
    outcomes: outcomes.length,
    activity: activity.length,
  };
}

export function createDrizzleResetStore(db: Db = getDb()): ResetStore {
  return {
    transaction: (fn) =>
      db.transaction(async (tx) => {
        const resetTx: ResetTx = {
          lock: async () => void (await tx.execute(RESET_LOCK_SQL)),
          latestGlobalReset: async () => {
            const rows = await tx
              .select({ createdAt: agentActivity.createdAt })
              .from(agentActivity)
              .where(and(eq(agentActivity.toolName, RESET_TOOL_GLOBAL), isNotNull(agentActivity.createdAt)))
              .orderBy(desc(agentActivity.createdAt))
              .limit(1);
            return rows[0]?.createdAt ?? null;
          },
          wipe: () => wipeAll(tx),
          seed: async (now) => void (await seedInto(tx, now)),
          log: (meta, createdAt) => insertActivity(tx, meta, createdAt),
        };
        return fn(resetTx);
      }),
  };
}

export function createDrizzleRestartStore(db: Db = getDb()): RestartStore {
  return {
    transaction: (fn) =>
      db.transaction(async (tx) => {
        const restartTx: RestartTx = {
          deleteSessionData: (sessionId) => wipeSession(tx, sessionId),
          log: (meta, createdAt) => insertActivity(tx, meta, createdAt),
        };
        return fn(restartTx);
      }),
  };
}
