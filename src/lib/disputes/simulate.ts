/**
 * Demo utilities for disputes (M3-06, REQ-DU-02, REQ-DIS-11).
 *
 *   simulateDispute: opens a synthetic dispute on a shipped order, for the calling session only.
 *   simulateOutcome: records Won / Lost on a demo dispute whose evidence was submitted (contest
 *                    path only; a refund records its outcome automatically in M2-05).
 *
 * Neither ever reaches PayPal. Both write `is_demo` / "simulated outcome" data only, and only for
 * the session that owns it.
 */
import type { Dispute, NewDispute, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { uuidV5 } from "@/seed/ids";
import { refundSnapshot } from "./executor";
import { isResolvedStatus, toDisputeView, type DisputeView } from "./read";
import type { DisputesRepo, RefundOutcomeInput } from "./types";

/** Simulated disputes get a 72-hour response window (tasks M3-06). */
export const SIMULATED_DEADLINE_HOURS = 72;
const HOUR_MS = 3_600_000;

export const SIMULATED_BUYER_MESSAGE =
  "Demo data: simulated dispute. The buyer says the parcel has not arrived and asks for a refund.";

export type SimulatedOutcome = "won" | "lost";

export interface SimulationRepo extends DisputesRepo {
  /** The order if this session may see it (its own, or a seeded one). */
  findVisibleOrder(orderId: string, sessionId: string): Promise<Order | null>;
  /** A dispute by id, whoever owns it (the caller checks ownership). */
  findDisputeById(id: string): Promise<Dispute | null>;
  /** INSERT ... ON CONFLICT (id) DO NOTHING. True when this call inserted the row. */
  insertDisputeIfAbsent(values: NewDispute & { id: string }): Promise<boolean>;
  /**
   * ONE transaction: move the dispute from `action_taken` to resolved_won / resolved_lost with
   * outcome_is_simulated = true; insert the dispute_outcomes row (ON CONFLICT DO NOTHING) and bump
   * `resolved_since_last_proposal` only if that row was inserted. `applied` is false when the
   * dispute was not in `action_taken` (nothing changed).
   */
  recordSimulatedOutcome(input: { disputeId: string; outcome: SimulatedOutcome; snapshot: RefundOutcomeInput }): Promise<{ applied: boolean; outcomeRecorded: boolean }>;
}

export interface SimulationDeps {
  repo: SimulationRepo;
  /** DEMO_MODE: any shipped order of the session may get a simulated dispute, not just demo data. */
  demoMode: boolean;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
  /** Called after an outcome row was inserted, for the learning loop (bound in M4). Never changes the result. */
  onOutcomeRecorded?: () => Promise<void>;
}

/** One simulated dispute per (session, order): a deterministic id makes the action idempotent and race-safe. */
export const simulatedDisputeId = (sessionId: string, orderId: string): string => uuidV5(`simulated-dispute:${sessionId}:${orderId}`);

export type SimulateDisputeResult =
  | { kind: "created"; disputeId: string }
  /** This session already simulated a dispute on this order: here it is. */
  | { kind: "exists"; disputeId: string }
  | { kind: "order_not_found" }
  | { kind: "not_shipped" }
  /** A real (non-demo) order outside Demo Mode. */
  | { kind: "not_allowed" };

async function bestEffort(log: SimulationDeps["log"], meta: ActivityMeta): Promise<void> {
  try {
    await log?.(meta);
  } catch {
    /* logging is best effort */
  }
}

export async function simulateDispute(req: { orderId: string; sessionId: string }, deps: SimulationDeps): Promise<SimulateDisputeResult> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const order = await deps.repo.findVisibleOrder(req.orderId, req.sessionId);
  if (!order) return { kind: "order_not_found" };

  const id = simulatedDisputeId(req.sessionId, order.id);
  const existing = await deps.repo.findDisputeById(id);
  if (existing) return { kind: "exists", disputeId: id };

  if (order.status !== "shipped") return { kind: "not_shipped" };
  if (!(order.isSeed || order.isDemo || deps.demoMode)) return { kind: "not_allowed" };

  const inserted = await deps.repo.insertDisputeIfAbsent({
    id,
    paypalDisputeId: null,
    orderId: order.id,
    reason: "item_not_received",
    buyerMessage: SIMULATED_BUYER_MESSAGE,
    disputedAmountUsd: order.amountUsd,
    deadlineOffsetHours: SIMULATED_DEADLINE_HOURS,
    // A fixed time, so the countdown really counts down (offsets are only re-applied to seeds).
    deadlineAt: new Date(now.getTime() + SIMULATED_DEADLINE_HOURS * HOUR_MS).toISOString(),
    status: "open",
    sessionId: req.sessionId,
    isSeed: false,
    isDemo: true,
  });
  // A concurrent click inserted it first: same id, same dispute.
  if (!inserted) return { kind: "exists", disputeId: id };

  await bestEffort(deps.log, {
    sessionId: req.sessionId,
    refOrderId: order.id,
    refDisputeId: id,
    stepType: "merchant_action",
    toolName: "simulate_dispute",
    inputSummary: `simulate a dispute on order ${order.id.slice(0, 8)}`,
    outputSummary: `synthetic item-not-received dispute opened; ${SIMULATED_DEADLINE_HOURS} h to respond; nothing was sent to PayPal`,
    durationMs: Date.now() - started,
    status: "simulated",
  });
  return { kind: "created", disputeId: id };
}

export type SimulateOutcomeResult =
  | { kind: "recorded"; outcome: SimulatedOutcome; outcomeRecorded: boolean; view: DisputeView }
  | { kind: "not_found" }
  /** Seeded, real, or another session's dispute: outcomes are only simulated on this session's demo disputes. */
  | { kind: "not_demo" }
  /** The refund path: its outcome was recorded automatically. */
  | { kind: "refund_path" }
  /** No submit_evidence action has been executed (or simulated) yet. */
  | { kind: "not_contested" }
  | { kind: "already_resolved"; view: DisputeView };

/** True when this dispute may get a simulated outcome: the session's own demo dispute, evidence submitted, not resolved. */
export function canSimulateOutcome(dispute: Dispute, sessionId: string, submittedEvidence: boolean): boolean {
  return isOwnDemo(dispute, sessionId) && submittedEvidence && dispute.status === "action_taken";
}

function isOwnDemo(dispute: Dispute, sessionId: string): boolean {
  return dispute.isDemo && !dispute.isSeed && dispute.sessionId === sessionId;
}

export async function simulateOutcome(
  req: { disputeId: string; sessionId: string; outcome: SimulatedOutcome },
  deps: SimulationDeps,
): Promise<SimulateOutcomeResult> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const record = await deps.repo.findVisible(req.disputeId, req.sessionId);
  if (!record) return { kind: "not_found" };
  const { dispute, order } = record;
  if (!isOwnDemo(dispute, req.sessionId)) return { kind: "not_demo" };

  const { executions } = await deps.repo.getActionHistory(dispute.id);
  const executed = executions.filter((e) => e.executedAt !== null);
  if (executed.some((e) => e.actionType === "accept_claim") || dispute.status === "resolved_refunded") return { kind: "refund_path" };
  if (isResolvedStatus(dispute.status)) return { kind: "already_resolved", view: toDisputeView(record, now) };
  if (!executed.some((e) => e.actionType === "submit_evidence") || dispute.status !== "action_taken") return { kind: "not_contested" };

  const snapshot = refundSnapshot(dispute, order, await deps.repo.getActiveWeightsId());
  const done = await deps.repo.recordSimulatedOutcome({ disputeId: dispute.id, outcome: req.outcome, snapshot });
  const current = (await deps.repo.findVisible(dispute.id, req.sessionId)) ?? record;
  if (!done.applied) {
    // A concurrent request resolved it first.
    return { kind: "already_resolved", view: toDisputeView(current, now) };
  }

  await bestEffort(deps.log, {
    sessionId: req.sessionId,
    refOrderId: order.id,
    refDisputeId: dispute.id,
    stepType: "merchant_action",
    toolName: "simulate_outcome",
    inputSummary: `simulate outcome ${req.outcome}`,
    outputSummary: `dispute resolved ${req.outcome} (simulated outcome)${done.outcomeRecorded ? "; outcome recorded for the learning loop" : ""}`,
    durationMs: Date.now() - started,
    status: "simulated",
  });
  if (done.outcomeRecorded) {
    try {
      await deps.onOutcomeRecorded?.();
    } catch {
      /* the learning-loop check must never change the result */
    }
  }
  return { kind: "recorded", outcome: req.outcome, outcomeRecorded: done.outcomeRecorded, view: toDisputeView(current, now) };
}
