/**
 * Reset demo, global (M4-05, REQ-DU-01) and "Restart my demo", session-scoped (REQ-DU-03).
 *
 * Both run inside ONE database transaction (through the `*Store` interfaces), so a failure part-way
 * leaves everything as it was. Neither touches `llm_daily_usage` or `llm_rate_limits`: the global
 * daily cap and the per-session hourly allowance must survive a reset.
 *
 *   resetDemo        deletes every visitor's data, then re-seeds the canonical records (weights, the
 *                    pending proposal, the counter, the insights cache, history, activity). Cooldown:
 *                    10 s since the last global reset, enforced inside the transaction behind an
 *                    advisory lock, so two clicks at once cannot both run.
 *   restartMyDemo    deletes ONLY the caller's own non-seed rows. It never touches the seed, other
 *                    sessions, the shared weights, the proposal, the counter or the insights cache.
 *
 * Each writes one `merchant_action` activity row (`reset_demo_global` / `reset_demo_session`).
 */
import type { ActivityMeta } from "@/lib/activity/logger";

export const RESET_COOLDOWN_MS = 10_000;
export const RESET_TOOL_GLOBAL = "reset_demo_global";
export const RESET_TOOL_SESSION = "reset_demo_session";

/** Rows removed, by table (visitor data only for the global reset: the seed's own rows are re-written, not counted). */
export interface WipeCounts {
  orders: number;
  evidenceArtefacts: number;
  disputes: number;
  approvals: number;
  executions: number;
  outcomes: number;
  activity: number;
}

export const EMPTY_COUNTS: WipeCounts = { orders: 0, evidenceArtefacts: 0, disputes: 0, approvals: 0, executions: 0, outcomes: 0, activity: 0 };

export function describeCounts(c: WipeCounts): string {
  return `${c.orders} order(s), ${c.disputes} dispute(s), ${c.evidenceArtefacts} evidence item(s), ${c.approvals} approval(s), ${c.executions} execution(s), ${c.outcomes} outcome(s), ${c.activity} activity row(s)`;
}

// ---------------------------------------------------------------------------
// Global reset
// ---------------------------------------------------------------------------
export interface ResetTx {
  /** Serialise concurrent resets (a transaction-scoped advisory lock). */
  lock(): Promise<void>;
  /** created_at of the newest `reset_demo_global` row, from any session; null if none. */
  latestGlobalReset(): Promise<string | null>;
  /** Delete all visitor data, in foreign-key order. */
  wipe(): Promise<WipeCounts>;
  /** Re-insert every seed row (upsert by seed id), timed from `now`. */
  seed(now: Date): Promise<void>;
  /** Insert one activity row with an explicit time. */
  log(meta: ActivityMeta, createdAt: string): Promise<void>;
}

export interface ResetStore {
  /** Run `fn` in one transaction: it commits when `fn` returns and rolls back when it throws. */
  transaction<T>(fn: (tx: ResetTx) => Promise<T>): Promise<T>;
}

export interface ResetDeps {
  store: ResetStore;
  now?: () => Date;
  /** After the commit: refresh the cached Insights summary if it is stale (it is not, right after a seed). */
  afterReset?: (sessionId: string) => Promise<void>;
}

export type ResetResult = { kind: "reset"; deleted: WipeCounts } | { kind: "cooldown"; retryAfterSeconds: number };

export async function resetDemo(sessionId: string, deps: ResetDeps): Promise<ResetResult> {
  const started = Date.now();
  const clock = deps.now ?? (() => new Date());

  const result = await deps.store.transaction<ResetResult>(async (tx) => {
    await tx.lock();
    const now = clock();

    const last = await tx.latestGlobalReset();
    if (last !== null) {
      const sinceMs = now.getTime() - new Date(last).getTime();
      if (sinceMs >= 0 && sinceMs < RESET_COOLDOWN_MS) {
        return { kind: "cooldown", retryAfterSeconds: Math.max(1, Math.ceil((RESET_COOLDOWN_MS - sinceMs) / 1000)) };
      }
    }

    const deleted = await tx.wipe();
    await tx.seed(now);
    // Last, so the reset's own row is the newest and the only non-seed activity row afterwards.
    await tx.log(
      {
        sessionId,
        stepType: "merchant_action",
        toolName: RESET_TOOL_GLOBAL,
        inputSummary: "reset the demo for all sessions",
        outputSummary: `removed ${describeCounts(deleted)}; restored the seed data, weights, pending proposal and insights cache`,
        durationMs: Date.now() - started,
        status: "success",
      },
      now.toISOString(),
    );
    return { kind: "reset", deleted };
  });

  if (result.kind === "reset") {
    try {
      await deps.afterReset?.(sessionId);
    } catch {
      /* the reset is committed; a failed summary refresh only means the page shows its rule-based summary */
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Session-scoped restart
// ---------------------------------------------------------------------------
export interface RestartTx {
  /** Delete the caller's own non-seed orders, disputes, evidence, approvals, executions, outcomes and activity. Nothing else. */
  deleteSessionData(sessionId: string): Promise<WipeCounts>;
  log(meta: ActivityMeta, createdAt: string): Promise<void>;
}

export interface RestartStore {
  transaction<T>(fn: (tx: RestartTx) => Promise<T>): Promise<T>;
}

export interface RestartDeps {
  store: RestartStore;
  now?: () => Date;
}

export type RestartResult = { kind: "restarted"; deleted: WipeCounts };

export async function restartMyDemo(sessionId: string, deps: RestartDeps): Promise<RestartResult> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const deleted = await deps.store.transaction(async (tx) => {
    const counts = await tx.deleteSessionData(sessionId);
    // The caller's activity was just deleted, so this is the only reset_demo_session row they have: idempotent.
    await tx.log(
      {
        sessionId,
        stepType: "merchant_action",
        toolName: RESET_TOOL_SESSION,
        inputSummary: "restart my demo (this session only)",
        outputSummary: `removed ${describeCounts(counts)}; the seed, other sessions, shared weights and the counter were not touched`,
        durationMs: Date.now() - started,
        status: "success",
      },
      now.toISOString(),
    );
    return counts;
  });
  return { kind: "restarted", deleted };
}
