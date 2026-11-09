/**
 * LLM budget guard (REQ-NFR-17): two limits, checked and counted together.
 *
 *   per session   10 model calls per hour (llm_rate_limits; the window starts at the session's
 *                 first call and resets once an hour has passed)
 *   per day       LLM_DAILY_CAP calls across everyone (llm_daily_usage, UTC day)
 *
 * Both counters are bumped with single-statement upserts inside one transaction, and a counter
 * moves only when the call is allowed:
 *   - concurrent requests cannot both take the last slot (the row lock serialises the upserts and
 *     the WHERE clause is re-checked after the lock);
 *   - if the session check passes but the day is full, the transaction rolls back, so the session
 *     is not charged for a call that never happens.
 * One unit is spent per call_with_fallback, not per provider attempt.
 */
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { getLlmEnv } from "@/lib/env";
import type { BudgetDecision } from "./call-with-fallback";

export const SESSION_CALLS_PER_WINDOW = 10;
export const SESSION_WINDOW_MS = 60 * 60 * 1000;
/** Calls with no session id share one bucket, so leaving the id out cannot dodge the limit. */
export const NO_SESSION_KEY = "(no-session)";

export interface BudgetOptions {
  /** Injectable clock, for tests. */
  now?: Date;
  sessionLimit?: number;
  /** Defaults to LLM_DAILY_CAP. */
  dailyCap?: number;
  db?: Pick<Db, "transaction">;
}

class BudgetDenied extends Error {
  constructor(readonly reason: "session" | "daily") {
    super(`LLM budget reached (${reason})`);
  }
}

/** Rows returned by an `INSERT ... RETURNING` run through Drizzle's `execute`. */
function rowsReturned(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rowCount = (result as { rowCount?: unknown } | null)?.rowCount;
  return typeof rowCount === "number" ? rowCount : 0;
}

/**
 * Take one LLM call from the session's hourly allowance and the day's global allowance, or say
 * which one is exhausted. Throws only if the database is unreachable (callWithFallback then falls
 * back to the rule-based result).
 */
export async function checkLlmBudget(sessionId: string | undefined, options: BudgetOptions = {}): Promise<BudgetDecision> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const windowCutoffIso = new Date(now.getTime() - SESSION_WINDOW_MS).toISOString();
  const day = nowIso.slice(0, 10);
  const key = sessionId && sessionId.trim() !== "" ? sessionId : NO_SESSION_KEY;
  const sessionLimit = options.sessionLimit ?? SESSION_CALLS_PER_WINDOW;
  const dailyCap = options.dailyCap ?? getLlmEnv().LLM_DAILY_CAP;
  const db = options.db ?? getDb();

  try {
    await db.transaction(async (tx) => {
      // A window older than an hour restarts at 1; otherwise the count goes up, but only below the limit.
      const session = await tx.execute(sql`
        INSERT INTO llm_rate_limits (session_id, call_count, window_start)
        VALUES (${key}, 1, ${nowIso})
        ON CONFLICT (session_id) DO UPDATE SET
          call_count = CASE WHEN llm_rate_limits.window_start < ${windowCutoffIso} THEN 1 ELSE llm_rate_limits.call_count + 1 END,
          window_start = CASE WHEN llm_rate_limits.window_start < ${windowCutoffIso} THEN ${nowIso} ELSE llm_rate_limits.window_start END
        WHERE llm_rate_limits.window_start < ${windowCutoffIso} OR llm_rate_limits.call_count < ${sessionLimit}
        RETURNING call_count`);
      if (rowsReturned(session) === 0) throw new BudgetDenied("session");

      const daily = await tx.execute(sql`
        INSERT INTO llm_daily_usage (day, call_count)
        VALUES (${day}, 1)
        ON CONFLICT (day) DO UPDATE SET call_count = llm_daily_usage.call_count + 1
        WHERE llm_daily_usage.call_count < ${dailyCap}
        RETURNING call_count`);
      if (rowsReturned(daily) === 0) throw new BudgetDenied("daily"); // rolls back the session increment as well
    });
    return { allowed: true };
  } catch (err) {
    if (err instanceof BudgetDenied) return { allowed: false, reason: err.reason };
    throw err;
  }
}
