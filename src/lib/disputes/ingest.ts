/**
 * Bring REAL PayPal disputes into the app (the smallest ingestion that works end to end).
 *
 * For one session it lists the PayPal disputes, reads each one, and links it to an order only when the disputed
 * transaction is the PayPal capture of an order that THIS SESSION owns (a real order: not seeded, not demo). A match
 * becomes a local dispute with is_demo = false, the real PayPal dispute id and reason, owned by that session. Nothing
 * else is ever created: a dispute that matches no order of the caller's is ignored, and one already linked to another
 * session is left alone and not reported. Reading only: nothing is sent to PayPal.
 *
 * Idempotent: the local id is derived from the PayPal dispute id, and the insert does nothing on a conflict.
 */
import type { Dispute, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { getDispute, listDisputes, type PayPalClient } from "@/lib/paypal";
import { uuidV5 } from "@/seed/ids";
import { formatIngestedBuyerMessage, mapPayPalReason } from "./paypal-reason";
import { describeResolution, mapPayPalResolution } from "./paypal-resolution";
import type { DisputeResolutionRepo } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** PayPal's inquiry stage lasts up to 20 days; used only when PayPal gives no response-due date. */
const FALLBACK_DEADLINE_DAYS = 20;
const MAX_DISPUTES_READ = 20;

export type NewDisputeRow = Omit<Dispute, "createdAt" | "updatedAt"> & Partial<Pick<Dispute, "createdAt" | "updatedAt">>;

export interface IngestRepo {
  /** An order of this session that is real (not seeded, not demo) and whose PayPal capture id is `captureId`. */
  findOwnRealOrderByCapture(sessionId: string, captureId: string): Promise<Order | null>;
  findDisputeByPaypalId(paypalDisputeId: string): Promise<{ id: string; sessionId: string | null } | null>;
  /** True when a row was inserted (false on a conflict). */
  insertDispute(values: NewDisputeRow): Promise<boolean>;
}

export interface IngestDeps {
  repo: IngestRepo;
  /** Null when PayPal credentials are absent. */
  paypal: PayPalClient | null;
  demoMode: boolean;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
  /** Lets a sync mark a linked dispute that PayPal closed as resolved. */
  resolution?: DisputeResolutionRepo;
}

export interface LinkedDispute {
  disputeId: string;
  paypalDisputeId: string;
  /** False when this session had already linked it. */
  created: boolean;
}

export type IngestResult =
  | { kind: "unavailable"; message: string }
  | {
      kind: "ok";
      /** PayPal disputes read. */
      checked: number;
      linked: LinkedDispute[];
      /** Linked disputes that PayPal has closed and that were marked resolved by this run. */
      closedOnPayPal: number;
      skipped: { resolved: number; unmatched: number; otherSession: number; unsupported: number; failed: number };
    };

export const localDisputeId = (paypalDisputeId: string): string => uuidV5(`paypal-dispute:${paypalDisputeId}`);

export async function ingestPayPalDisputes(sessionId: string, deps: IngestDeps): Promise<IngestResult> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  if (deps.demoMode) return { kind: "unavailable", message: "Demo Mode is on, so PayPal is not contacted." };
  if (!deps.paypal) return { kind: "unavailable", message: "PayPal credentials are not configured." };
  const client = deps.paypal;

  const log = async (outputSummary: string, status: ActivityMeta["status"]) => {
    try {
      await deps.log?.({ sessionId, stepType: "paypal_api", toolName: "sync_disputes", inputSummary: "look for PayPal disputes on this session's orders", outputSummary, durationMs: Date.now() - started, status });
    } catch {
      /* logging is best effort */
    }
  };

  let items: Awaited<ReturnType<typeof listDisputes>>;
  try {
    items = await listDisputes(client, { pageSize: 50 });
  } catch (err) {
    await log(`could not list PayPal disputes (${err instanceof Error ? err.message.slice(0, 120) : "error"})`, "error");
    return { kind: "unavailable", message: "PayPal could not be reached, so nothing was checked. Try again in a moment." };
  }

  const skipped = { resolved: 0, unmatched: 0, otherSession: 0, unsupported: 0, failed: 0 };
  const linked: LinkedDispute[] = [];
  let checked = 0;
  let closedNow = 0;

  for (const item of items.slice(0, MAX_DISPUTES_READ)) {
    if (item.status === "RESOLVED") {
      // A dispute this session already linked and PayPal has now closed: record PayPal's outcome (no approval, execution or
      // learning-loop change). One that was never linked is simply skipped.
      const mine = await deps.repo.findDisputeByPaypalId(item.dispute_id);
      if (mine && mine.sessionId === sessionId && deps.resolution) {
        try {
          const detail = await getDispute(client, item.dispute_id);
          const resolved = mapPayPalResolution({ status: detail.status, disputeState: detail.dispute_state, outcomeCode: detail.dispute_outcome?.outcome_code });
          const updated = await deps.resolution.markResolvedOnPayPal({ id: mine.id, status: resolved.status, outcome: resolved.outcome, note: describeResolution(resolved, detail.dispute_outcome?.outcome_reason) });
          if (updated) {
            closedNow++;
            try {
              await deps.log?.({ sessionId, refDisputeId: mine.id, stepType: "paypal_api", toolName: "dispute_resolved_on_paypal", inputSummary: "PayPal reports the dispute as closed", outputSummary: `${resolved.paypalOutcome ?? "closed"}; marked ${resolved.status}; no approval, execution or learning-loop change`, durationMs: 0, status: "success" });
            } catch {
              /* logging is best effort */
            }
          }
        } catch {
          skipped.failed++;
        }
      }
      skipped.resolved++;
      continue;
    }
    const existing = await deps.repo.findDisputeByPaypalId(item.dispute_id);
    if (existing) {
      if (existing.sessionId === sessionId) linked.push({ disputeId: existing.id, paypalDisputeId: item.dispute_id, created: false });
      else skipped.otherSession++; // someone else's: not touched, not revealed
      continue;
    }

    let detail: Awaited<ReturnType<typeof getDispute>>;
    try {
      detail = await getDispute(client, item.dispute_id);
      checked++;
    } catch {
      skipped.failed++;
      continue;
    }

    let order: Order | null = null;
    for (const t of detail.disputed_transactions ?? []) {
      for (const txnId of [t.seller_transaction_id, t.buyer_transaction_id]) {
        if (order || !txnId) continue;
        order = await deps.repo.findOwnRealOrderByCapture(sessionId, txnId);
      }
    }
    if (!order) {
      skipped.unmatched++;
      continue;
    }
    if (detail.dispute_amount && detail.dispute_amount.currency_code !== "USD") {
      skipped.unsupported++; // the app only handles USD amounts
      continue;
    }

    const amount = detail.dispute_amount ? Number(detail.dispute_amount.value) : order.amountUsd;
    const buyerText = (detail.messages ?? []).find((m) => m.posted_by === "BUYER")?.content ?? null;
    const dueIso = detail.seller_response_due_date && !Number.isNaN(Date.parse(detail.seller_response_due_date)) ? new Date(detail.seller_response_due_date).toISOString() : null;
    const id = localDisputeId(item.dispute_id);
    const created = await deps.repo.insertDispute({
      id,
      paypalDisputeId: item.dispute_id,
      orderId: order.id,
      reason: mapPayPalReason(detail.reason).reason,
      buyerMessage: formatIngestedBuyerMessage(detail.reason, buyerText),
      disputedAmountUsd: Number.isFinite(amount) ? amount : order.amountUsd,
      deadlineOffsetHours: null,
      deadlineAt: dueIso ?? new Date(now.getTime() + FALLBACK_DEADLINE_DAYS * DAY_MS).toISOString(),
      status: "open",
      outcome: null,
      outcomeIsSimulated: false,
      baseWinProbability: null,
      llmAdjustment: null,
      winProbability: null,
      winLikelihoodLabel: null,
      systemRecommendation: null,
      overrideRecommendation: null,
      finalRecommendation: null,
      recommendationSource: null,
      reasoning: null,
      evidenceUsed: null,
      evidenceGaps: null,
      draftResponse: null,
      analysisComputedAt: null,
      riskScoreSnapshot: null,
      sessionId,
      isSeed: false,
      isDemo: false,
    });
    linked.push({ disputeId: id, paypalDisputeId: item.dispute_id, created });
  }

  await log(`read ${checked} dispute(s); linked ${linked.length} (${linked.filter((l) => l.created).length} new); ${closedNow} closed on PayPal; ${skipped.unmatched} matched none of your orders`, "success");
  return { kind: "ok", checked, linked, closedOnPayPal: closedNow, skipped };
}
