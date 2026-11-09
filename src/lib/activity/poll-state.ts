/**
 * The pure rules behind the activity feed's polling: what the status line says after a success or a failure,
 * and how long to wait before the next poll. The React hook (`polling.ts`) only wires these to timers.
 */

/** A poll got an HTTP answer that was not 2xx. */
export class PollHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "PollHttpError";
  }
}

export interface Health {
  /** Failed polls in a row (a success resets it). */
  failures: number;
  /** The server said 401: the session is over, so polling stops. */
  sessionEnded: boolean;
}

export type FeedState = "ok" | "retrying" | "error" | "session-ended";

export const INITIAL_HEALTH: Health = { failures: 0, sessionEnded: false };

/** One failed poll is a hiccup (quiet "retrying"); this many in a row is worth an error message. */
export const FAILURES_BEFORE_ERROR = 3;

export function afterSuccess(): Health {
  return INITIAL_HEALTH;
}

export function afterFailure(prev: Health, error: unknown): Health {
  if (error instanceof PollHttpError && error.status === 401) return { failures: prev.failures, sessionEnded: true };
  return { failures: prev.failures + 1, sessionEnded: prev.sessionEnded };
}

export function feedState(health: Health): FeedState {
  if (health.sessionEnded) return "session-ended";
  if (health.failures >= FAILURES_BEFORE_ERROR) return "error";
  if (health.failures > 0) return "retrying";
  return "ok";
}

/** Wait one interval; after repeated failures back off to 2x, then 4x (never more), so a struggling server is not hammered. */
export function nextDelayMs(intervalMs: number, health: Health): number {
  if (health.failures < FAILURES_BEFORE_ERROR) return intervalMs;
  return Math.min(intervalMs * 2 ** (health.failures - FAILURES_BEFORE_ERROR + 1), intervalMs * 4);
}

export const FEED_STATUS_TEXT: Record<FeedState, string> = {
  ok: "Updates every 5 seconds",
  retrying: "Refresh delayed, retrying",
  error: "Could not refresh; still trying",
  "session-ended": "Your session has ended; sign in again",
};
