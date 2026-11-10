/**
 * Dispute read layer (M2-01, REQ-DIS-01, REQ-DEMO-01).
 *
 * The local `disputes` table is the system of record (seeded, simulated and PayPal-linked disputes
 * all live there), exactly like orders. For a dispute that is linked to a real PayPal dispute id,
 * the deadline is refreshed from PayPal when it can be; if PayPal fails, the stored record is used
 * and a Demo Mode event is logged. Seeded and demo disputes never cause a PayPal call.
 */
import type { Dispute, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { getDispute, withDemoFallback, type PayPalClient } from "@/lib/paypal";
import { demoCopyId } from "@/lib/demo/ids";
import { isAnalysed } from "./analysis-state";
import { computeDeadline } from "./deadline";
import { allowedActions, isRealDispute, type LiveDisputeInfo } from "./paypal-reason";
import type { DisputeRecord, DisputesReadRepo } from "./types";

export const RESOLVED_STATUSES = ["resolved_won", "resolved_lost", "resolved_refunded"] as const;

export function isResolvedStatus(status: Dispute["status"]): boolean {
  return (RESOLVED_STATUSES as readonly string[]).includes(status);
}

export interface DisputeAnalysisView {
  baseWinProbability: number | null;
  /** The model's adjustment after the system clamped it to +/-0.1; null when the AI step was unavailable. */
  llmAdjustment: number | null;
  /** Null when the AI step was unavailable: the page then shows no win-likelihood meter. */
  winProbability: number | null;
  winLikelihoodLabel: Dispute["winLikelihoodLabel"];
  systemRecommendation: Dispute["systemRecommendation"];
  overrideRecommendation: Dispute["overrideRecommendation"];
  finalRecommendation: Dispute["finalRecommendation"];
  recommendationSource: Dispute["recommendationSource"];
  reasoning: string | null;
  evidenceUsed: string[];
  evidenceGaps: string[];
  draftResponse: string | null;
  /** True when the analysis was stored without the AI step (system recommendation only). */
  aiUnavailable: boolean;
  computedAt: string;
}

export interface DisputeView {
  id: string;
  orderId: string;
  /** Short order reference for tables. */
  orderRef: string;
  reason: Dispute["reason"];
  status: Dispute["status"];
  outcome: Dispute["outcome"];
  outcomeIsSimulated: boolean;
  amountUsd: number;
  /** ISO. Seed disputes: now + their stored offset, recomputed on every read. */
  deadlineAt: string;
  /** True for seeded and demo disputes (the "Demo data" badge). */
  isDemo: boolean;
  /** True for a shared seed (read-only for every session; "Start demo" makes an own copy). */
  isSharedExample: boolean;
  buyerMessage: string | null;
  createdAt: string;
  /** When a resolved dispute was resolved (null while open). */
  resolvedAt: string | null;
  analysis: DisputeAnalysisView | null;
}

export function toAnalysisView(d: Dispute): DisputeAnalysisView | null {
  // A claim ("pending:...") means an analysis is being computed: it is not an analysis yet.
  if (!isAnalysed(d.analysisComputedAt)) return null;
  return {
    baseWinProbability: d.baseWinProbability,
    llmAdjustment: d.llmAdjustment,
    winProbability: d.winProbability,
    winLikelihoodLabel: d.winLikelihoodLabel,
    systemRecommendation: d.systemRecommendation,
    overrideRecommendation: d.overrideRecommendation,
    finalRecommendation: d.finalRecommendation,
    recommendationSource: d.recommendationSource,
    reasoning: d.reasoning,
    evidenceUsed: d.evidenceUsed ?? [],
    evidenceGaps: d.evidenceGaps ?? [],
    draftResponse: d.draftResponse,
    aiUnavailable: d.winProbability === null,
    computedAt: d.analysisComputedAt,
  };
}

export function toDisputeView(record: DisputeRecord, now: Date, deadlineOverride?: string): DisputeView {
  const { dispute: d, order } = record;
  return {
    id: d.id,
    orderId: d.orderId,
    orderRef: order.id.slice(0, 8),
    reason: d.reason,
    status: d.status,
    outcome: d.outcome,
    outcomeIsSimulated: d.outcomeIsSimulated,
    amountUsd: d.disputedAmountUsd,
    deadlineAt: deadlineOverride ?? computeDeadline(d, now),
    isDemo: d.isSeed || d.isDemo,
    isSharedExample: d.isSeed,
    buyerMessage: d.buyerMessage,
    createdAt: d.createdAt,
    resolvedAt: isResolvedStatus(d.status) ? d.updatedAt : null,
    analysis: toAnalysisView(d),
  };
}

export interface DisputeReadDeps {
  repo: DisputesReadRepo;
  /** Null when PayPal credentials are absent. */
  paypal: PayPalClient | null;
  demoMode: boolean;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
}

/** A deadline from PayPal for a live-linked dispute, or null to keep the stored one. */
async function liveDeadline(record: DisputeRecord, sessionId: string, deps: DisputeReadDeps): Promise<string | null> {
  const { dispute: d } = record;
  if (d.isSeed || d.isDemo || !d.paypalDisputeId) return null; // nothing live to ask

  const started = Date.now();
  const paypalId = d.paypalDisputeId;
  const client = deps.paypal;
  const result = await withDemoFallback<string | null>(
    client ? async () => (await getDispute(client, paypalId)).seller_response_due_date ?? null : null,
    () => null,
    {
      demoMode: deps.demoMode,
      onFallback: async ({ reason, message }) => {
        try {
          await deps.log?.({
            sessionId,
            refDisputeId: d.id,
            stepType: "paypal_api",
            toolName: "get_dispute",
            inputSummary: "refresh deadline from PayPal",
            outputSummary: `Demo Mode (${reason})${message ? `: ${message}` : ""}; used the stored record`,
            durationMs: Date.now() - started,
            status: "simulated",
          });
        } catch {
          /* logging is best effort */
        }
      },
    },
  );
  const due = result.data;
  return due && !Number.isNaN(new Date(due).getTime()) ? new Date(due).toISOString() : null;
}

/**
 * A fresh read of a REAL PayPal dispute: its real status and stage, the due date and what PayPal allows now. Null for any
 * other dispute. Never falls back to stored data: when PayPal cannot be read, `readFailed` says so and no write is offered.
 */
export async function readLiveDispute(record: DisputeRecord, sessionId: string, deps: DisputeReadDeps): Promise<LiveDisputeInfo | null> {
  const { dispute: d } = record;
  if (!isRealDispute(d)) return null;
  const paypalDisputeId = d.paypalDisputeId!;
  const empty: LiveDisputeInfo = { paypalDisputeId, reasonCode: null, status: null, state: null, stage: null, dueDate: null, allowed: [], readFailed: null };
  if (deps.demoMode) return { ...empty, readFailed: "Demo Mode is on, so PayPal is not contacted and this real dispute cannot be acted on." };
  if (!deps.paypal) return { ...empty, readFailed: "PayPal credentials are not configured." };

  const started = Date.now();
  try {
    const live = await getDispute(deps.paypal, paypalDisputeId);
    try {
      await deps.log?.({ sessionId, refDisputeId: d.id, stepType: "paypal_api", toolName: "get_dispute", inputSummary: "read the live dispute from PayPal", outputSummary: `status ${live.status}; stage ${live.dispute_life_cycle_stage ?? "?"}`, durationMs: Date.now() - started, status: "success" });
    } catch {
      /* logging is best effort */
    }
    return {
      paypalDisputeId,
      reasonCode: live.reason ?? null,
      status: live.status,
      state: live.dispute_state ?? null,
      stage: live.dispute_life_cycle_stage ?? null,
      dueDate: live.seller_response_due_date && !Number.isNaN(Date.parse(live.seller_response_due_date)) ? new Date(live.seller_response_due_date).toISOString() : null,
      allowed: allowedActions(live.allowed_response_options),
      readFailed: null,
    };
  } catch {
    return { ...empty, readFailed: "PayPal could not be read right now." };
  }
}

export type DisputeTab = "open" | "resolved";

/** Visible disputes for one tab. Open: soonest deadline first. Resolved: most recently resolved first. */
export async function listDisputeViews(sessionId: string, tab: DisputeTab, deps: DisputeReadDeps): Promise<DisputeView[]> {
  const now = (deps.now ?? (() => new Date()))();
  const all = await deps.repo.listVisible(sessionId);
  // A seed this session has its own Start demo copy of is not listed: the copy stands in for it.
  const ids = new Set(all.map((r) => r.dispute.id));
  const records = all.filter((r) => !(r.dispute.isSeed && ids.has(demoCopyId(sessionId, r.dispute.id))));
  const wanted = records.filter((r) => isResolvedStatus(r.dispute.status) === (tab === "resolved"));

  const views: DisputeView[] = [];
  for (const record of wanted) {
    const live = tab === "open" ? await liveDeadline(record, sessionId, deps) : null;
    views.push(toDisputeView(record, now, live ?? undefined));
  }

  return tab === "open"
    ? views.sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt) || a.id.localeCompare(b.id))
    : views.sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "") || a.id.localeCompare(b.id));
}

export async function getDisputeView(
  id: string,
  sessionId: string,
  deps: DisputeReadDeps,
): Promise<{ view: DisputeView; order: Order; dispute: Dispute } | null> {
  const now = (deps.now ?? (() => new Date()))();
  const record = await deps.repo.findVisible(id, sessionId);
  if (!record) return null;
  const live = isResolvedStatus(record.dispute.status) ? null : await liveDeadline(record, sessionId, deps);
  return { view: toDisputeView(record, now, live ?? undefined), order: record.order, dispute: record.dispute };
}
