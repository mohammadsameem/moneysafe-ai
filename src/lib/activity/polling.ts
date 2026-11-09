import { useEffect, useRef, useState } from "react";

/**
 * Polling state for the activity feed. Tracks transient and persistent errors,
 * session expiry, and keeps the last good data visible during transient errors.
 */
export interface PollState<T> {
  /** Latest successful data, kept even during transient errors. */
  data: T | null;
  /** Quiet transient state: shown after 1st failure, cleared on next success. */
  retrying: boolean;
  /** Persistent error: shown after 3 consecutive failures. */
  error: boolean;
  /** Session ended (401): stop polling, show a special message. */
  sessionEnded: boolean;
}

interface UsePollOptions<T> {
  /** The fetch function: should throw on non-ok status or parse errors. */
  fetchFn: () => Promise<T>;
  /** Poll interval in ms (default 5000). */
  intervalMs?: number;
  /** Backoff multiplier on errors (default 2, max 4x the base interval). */
  backoffFactor?: number;
  /** If true, don't poll on mount; only start when filters change or manually. */
  skipInitialPoll?: boolean;
}

/**
 * React hook for robust polling with:
 * - Non-overlapping requests (in-flight guard)
 * - Tab visibility pause/resume (pauses when hidden, resumes immediately when visible)
 * - Backoff on errors (2x interval after 3 failures, max 4x)
 * - Special 401 handling (session ended, stops polling)
 * - Transient vs persistent error states (quiet retry after 1 failure, persistent error after 3)
 *
 * The poller does NOT start on mount if `skipInitialPoll` is true. Otherwise it polls immediately.
 * It pauses when the tab is hidden and resumes when visible.
 */
export function usePoll<T>(options: UsePollOptions<T>): PollState<T> {
  const { fetchFn, intervalMs = 5000, backoffFactor = 2, skipInitialPoll = false } = options;

  const [state, setState] = useState<PollState<T>>({
    data: null,
    retrying: false,
    error: false,
    sessionEnded: false,
  });

  const inflightRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const currentIntervalRef = useRef(intervalMs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useRef(() => {
    if (inflightRef.current || state.sessionEnded) return;
    if (document.visibilityState !== "visible") return;

    inflightRef.current = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    fetchFn()
      .then((data) => {
        clearTimeout(timeout);
        inflightRef.current = false;
        consecutiveFailuresRef.current = 0;
        currentIntervalRef.current = intervalMs;
        setState({ data, retrying: false, error: false, sessionEnded: false });
      })
      .catch((err: unknown) => {
        clearTimeout(timeout);
        inflightRef.current = false;

        const is401 = err instanceof Error && /401|unauthorized/i.test(err.message);
        if (is401) {
          setState((prev) => ({ ...prev, retrying: false, error: false, sessionEnded: true }));
          return; // stop polling
        }

        consecutiveFailuresRef.current++;
        if (consecutiveFailuresRef.current === 1) {
          setState((prev) => ({ ...prev, retrying: true, error: false }));
        } else if (consecutiveFailuresRef.current >= 3) {
          setState((prev) => ({ ...prev, retrying: false, error: true }));
          currentIntervalRef.current = Math.min(intervalMs * backoffFactor, intervalMs * 4);
        }
      });
  });

  // Update the poll ref when fetchFn changes (e.g. filters changed)
  poll.current = () => {
    if (inflightRef.current || state.sessionEnded) return;
    if (document.visibilityState !== "visible") return;

    inflightRef.current = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    fetchFn()
      .then((data) => {
        clearTimeout(timeout);
        inflightRef.current = false;
        consecutiveFailuresRef.current = 0;
        currentIntervalRef.current = intervalMs;
        setState({ data, retrying: false, error: false, sessionEnded: false });
      })
      .catch((err: unknown) => {
        clearTimeout(timeout);
        inflightRef.current = false;

        const is401 = err instanceof Error && /401|unauthorized/i.test(err.message);
        if (is401) {
          setState((prev) => ({ ...prev, retrying: false, error: false, sessionEnded: true }));
          return;
        }

        consecutiveFailuresRef.current++;
        if (consecutiveFailuresRef.current === 1) {
          setState((prev) => ({ ...prev, retrying: true, error: false }));
        } else if (consecutiveFailuresRef.current >= 3) {
          setState((prev) => ({ ...prev, retrying: false, error: true }));
          currentIntervalRef.current = Math.min(intervalMs * backoffFactor, intervalMs * 4);
        }
      });
  };

  useEffect(() => {
    if (state.sessionEnded) return;

    const scheduleNext = () => {
      if (state.sessionEnded) return;
      timerRef.current = setTimeout(() => {
        poll.current();
        scheduleNext();
      }, currentIntervalRef.current);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !state.sessionEnded) {
        poll.current(); // immediate poll when tab becomes visible
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (!skipInitialPoll) poll.current();
    scheduleNext();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchFn, intervalMs, state.sessionEnded]);

  return state;
}
