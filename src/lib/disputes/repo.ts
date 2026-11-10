/**
 * Drizzle implementation of the disputes stores. Thin on purpose: every rule lives in the service
 * modules, which are tested against an in-memory fake with the same semantics.
 */
import { and, asc, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { errorCode } from "@/lib/activity/logger";
import {
  actionExecutions,
  approvalRecords,
  disputeOutcomes,
  disputes,
  evidenceArtefacts,
  orders,
  signalWeights,
} from "@/db/schema";
import { isUuid } from "@/lib/orders/queries";
import { CLAIM_PREFIX, CLAIM_TIME_LENGTH, CLAIM_TIME_START } from "./analysis-state";
import type { IngestRepo } from "./ingest";
import type { SimulationRepo } from "./simulate";
import {
  ApprovalConflictError,
  type AnalysisPatch,
  type CompleteExecutionResult,
  type DisputeRecord,
  type DisputesRepo,
} from "./types";

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Count one resolved dispute on the active weights row; returns the counter right after (RETURNING). */
async function bumpResolvedCounter(tx: Tx): Promise<number | null> {
  const rows = await tx
    .update(signalWeights)
    .set({ resolvedSinceLastProposal: sql`${signalWeights.resolvedSinceLastProposal} + 1` })
    .where(eq(signalWeights.isActive, true))
    .returning({ counter: signalWeights.resolvedSinceLastProposal });
  return rows[0]?.counter ?? null;
}

export function createDrizzleDisputesRepo(db: Db = getDb()): DisputesRepo {
  const joined = () => db.select({ dispute: disputes, order: orders }).from(disputes).innerJoin(orders, eq(disputes.orderId, orders.id));
  const visible = (sessionId: string) => or(eq(disputes.isSeed, true), eq(disputes.sessionId, sessionId));

  return {
    // ---- reads ---------------------------------------------------------------
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

    // ---- analysis ------------------------------------------------------------
    async claimAnalysis(id, token, staleBeforeIso) {
      // One statement, so exactly one concurrent caller can win it.
      const rows = await db
        .update(disputes)
        .set({ analysisComputedAt: token })
        .where(
          and(
            eq(disputes.id, id),
            or(
              isNull(disputes.analysisComputedAt),
              and(
                like(disputes.analysisComputedAt, `${CLAIM_PREFIX}%`),
                or(
                  lt(sql`substr(${disputes.analysisComputedAt}, ${CLAIM_TIME_START}, ${CLAIM_TIME_LENGTH})`, staleBeforeIso),
                  // A claim whose time is not a timestamp can never be completed or compared: take it over.
                  sql`substr(${disputes.analysisComputedAt}, ${CLAIM_TIME_START}, ${CLAIM_TIME_LENGTH}) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'`,
                ),
              ),
            ),
          ),
        )
        .returning({ id: disputes.id });
      return rows.length > 0;
    },

    async saveAnalysis(id, patch: AnalysisPatch, token) {
      const rows = await db
        .update(disputes)
        .set(patch)
        .where(and(eq(disputes.id, id), eq(disputes.analysisComputedAt, token)))
        .returning();
      return rows[0] ?? null;
    },

    async releaseAnalysisClaim(id, token) {
      await db.update(disputes).set({ analysisComputedAt: null }).where(and(eq(disputes.id, id), eq(disputes.analysisComputedAt, token)));
    },

    // ---- approvals and executions -----------------------------------------------
    async findApprovalById(id) {
      if (!isUuid(id)) return null;
      const rows = await db.select().from(approvalRecords).where(eq(approvalRecords.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async findApprovedApproval(disputeId, actionType) {
      const rows = await db
        .select()
        .from(approvalRecords)
        .where(and(eq(approvalRecords.disputeId, disputeId), eq(approvalRecords.actionType, actionType), eq(approvalRecords.decision, "approved")))
        .limit(1);
      return rows[0] ?? null;
    },

    async getExecutionByApproval(approvalRecordId) {
      const rows = await db.select().from(actionExecutions).where(eq(actionExecutions.approvalRecordId, approvalRecordId)).limit(1);
      return rows[0] ?? null;
    },

    async getActionHistory(disputeId) {
      const [approvals, executions] = await Promise.all([
        db.select().from(approvalRecords).where(eq(approvalRecords.disputeId, disputeId)).orderBy(asc(approvalRecords.createdAt)),
        db.select().from(actionExecutions).where(eq(actionExecutions.disputeId, disputeId)).orderBy(asc(actionExecutions.createdAt)),
      ]);
      return { approvals, executions };
    },

    async getActiveWeightsId() {
      const rows = await db.select({ id: signalWeights.id }).from(signalWeights).where(eq(signalWeights.isActive, true)).limit(1);
      return rows[0]?.id ?? null;
    },

    async insertApprovalWithExecution(input) {
      try {
        return await db.transaction(async (tx) => {
          const [approval] = await tx
            .insert(approvalRecords)
            .values({
              disputeId: input.disputeId,
              actionType: input.actionType,
              merchantUserId: input.merchantUserId,
              decision: "approved",
              payloadHash: input.payloadHash,
            })
            .returning();
          if (!approval) throw new Error("approval insert returned no row");
          const [execution] = await tx
            .insert(actionExecutions)
            .values({
              approvalRecordId: approval.id,
              disputeId: input.disputeId,
              actionType: input.actionType,
              approvedPayload: input.approvedPayload,
              originalDraft: input.originalDraft,
              editedDraft: input.editedDraft,
              paypalRequestId: input.paypalRequestId,
            })
            .returning();
          if (!execution) throw new Error("execution insert returned no row");
          return { approval, execution };
        });
      } catch (err) {
        // The partial unique index (dispute, action) WHERE decision = 'approved' fired: someone else won.
        if (errorCode(err) === UNIQUE_VIOLATION) throw new ApprovalConflictError();
        throw err;
      }
    },

    async insertRejection(input) {
      const [row] = await db
        .insert(approvalRecords)
        .values({ disputeId: input.disputeId, actionType: input.actionType, merchantUserId: input.merchantUserId, decision: "rejected", payloadHash: input.payloadHash })
        .returning();
      if (!row) throw new Error("rejection insert returned no row");
      return row;
    },

    async completeExecution(input): Promise<CompleteExecutionResult> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(actionExecutions)
          .set({ executedAt: input.executedAt, isSimulated: input.isSimulated, paypalResponse: input.paypalResponse })
          .where(and(eq(actionExecutions.id, input.executionId), isNull(actionExecutions.executedAt)))
          .returning();
        const execution = updated[0];
        if (!execution) return { applied: false, execution: null, outcomeRecorded: false, counterAfter: null }; // already completed

        if (input.actionType === "submit_evidence") {
          await tx.update(disputes).set({ status: "action_taken" }).where(and(eq(disputes.id, input.disputeId), eq(disputes.status, "open")));
          return { applied: true, execution, outcomeRecorded: false, counterAfter: null };
        }

        // accept_claim: the refund outcome is recorded automatically (REQ-DIS-09).
        await tx
          .update(disputes)
          .set({ status: "resolved_refunded", outcome: "refunded", outcomeIsSimulated: input.isSimulated })
          .where(and(eq(disputes.id, input.disputeId), inArray(disputes.status, ["open", "action_taken"])));
        const outcome = input.refundOutcome;
        if (!outcome) throw new Error("accept_claim completion needs a refund outcome snapshot");
        const inserted = await tx
          .insert(disputeOutcomes)
          .values({
            disputeId: input.disputeId,
            outcome: "refunded",
            riskScoreSnapshot: outcome.riskScoreSnapshot,
            verdictSnapshot: outcome.verdictSnapshot,
            winProbabilitySnapshot: outcome.winProbabilitySnapshot,
            signalWeightsId: outcome.signalWeightsId,
            isSimulated: input.isSimulated,
          })
          .onConflictDoNothing({ target: disputeOutcomes.disputeId })
          .returning({ id: disputeOutcomes.id });
        const recorded = inserted.length > 0;
        // Count it only if this call created the outcome row, so a retry can never count it twice.
        let counterAfter: number | null = null;
        if (recorded) counterAfter = await bumpResolvedCounter(tx);
        return { applied: true, execution, outcomeRecorded: recorded, counterAfter };
      });
    },
  };
}

/** What linking a real PayPal dispute needs (see ingest.ts). Every lookup is scoped to the calling session. */
export function createDrizzleIngestRepo(db: Db = getDb()): IngestRepo {
  return {
    async findOwnRealOrderByCapture(sessionId, captureId) {
      const rows = await db
        .select()
        .from(orders)
        .where(and(eq(orders.paypalCaptureId, captureId), eq(orders.sessionId, sessionId), eq(orders.isSeed, false), eq(orders.isDemo, false)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findDisputeByPaypalId(paypalDisputeId) {
      const rows = await db.select({ id: disputes.id, sessionId: disputes.sessionId }).from(disputes).where(eq(disputes.paypalDisputeId, paypalDisputeId)).limit(1);
      return rows[0] ?? null;
    },

    async insertDispute(values) {
      const rows = await db.insert(disputes).values(values).onConflictDoNothing().returning({ id: disputes.id });
      return rows.length > 0;
    },
  };
}

/** The read-only view of the same repo (kept for callers that only list and open disputes). */
export const createDrizzleDisputesReadRepo = createDrizzleDisputesRepo;

/** The disputes repo plus what the demo utilities need (M3-06, M3-08). */
export function createDrizzleSimulationRepo(db: Db = getDb()): SimulationRepo {
  return {
    ...createDrizzleDisputesRepo(db),

    async findVisibleOrder(orderId, sessionId) {
      if (!isUuid(orderId)) return null;
      const rows = await db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), or(eq(orders.isSeed, true), eq(orders.sessionId, sessionId))))
        .limit(1);
      return rows[0] ?? null;
    },

    async findDisputeById(id) {
      if (!isUuid(id)) return null;
      const rows = await db.select().from(disputes).where(eq(disputes.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async insertDisputeIfAbsent(values) {
      const rows = await db.insert(disputes).values(values).onConflictDoNothing({ target: disputes.id }).returning({ id: disputes.id });
      return rows.length > 0;
    },

    async recordSimulatedOutcome({ disputeId, outcome, snapshot }) {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(disputes)
          .set({ status: outcome === "won" ? "resolved_won" : "resolved_lost", outcome, outcomeIsSimulated: true })
          .where(and(eq(disputes.id, disputeId), eq(disputes.status, "action_taken"), eq(disputes.isDemo, true), eq(disputes.isSeed, false)))
          .returning({ id: disputes.id });
        if (updated.length === 0) return { applied: false, outcomeRecorded: false, counterAfter: null };

        const inserted = await tx
          .insert(disputeOutcomes)
          .values({
            disputeId,
            outcome,
            riskScoreSnapshot: snapshot.riskScoreSnapshot,
            verdictSnapshot: snapshot.verdictSnapshot,
            winProbabilitySnapshot: snapshot.winProbabilitySnapshot,
            signalWeightsId: snapshot.signalWeightsId,
            isSimulated: true,
          })
          .onConflictDoNothing({ target: disputeOutcomes.disputeId })
          .returning({ id: disputeOutcomes.id });
        const recorded = inserted.length > 0;
        let counterAfter: number | null = null;
        if (recorded) counterAfter = await bumpResolvedCounter(tx);
        return { applied: true, outcomeRecorded: recorded, counterAfter };
      });
    },
  };
}
