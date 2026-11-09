import { useEffect, useRef, useState } from "react";
import { INITIAL_HEALTH, afterFailure, afterSuccess, feedState, nextDelayMs, type FeedState, type Health } from "./poll-state";

export interface PollResult<T> {
  /** The latest answer for the CURRENT query (kept through failures), or null while a changed query is loading. */
  data: T | null;
  state: FeedState;
}

interface Options<T> {
  /** One request. Must throw a `PollHttpError` on a non-2xx answer, and must pass `signal` to `fetch`. */
  fetchFn: (signal: AbortSignal) => Promise<T>;
  /** Identifies the query. When it changes, the new query is fetched straight away. */
  queryKey: string;
  /** Server-rendered data for the query the component first rendered with, so mount needs no request. */
  initial: T;
  intervalMs?: number;
  /** A request that takes longer than this is aborted and counted as a failure. */
  timeoutMs?: number;
}

interface Snapshot<T> {
  key: string;
  data: T;
  health: Health;
}

/**
 * Poll `fetchFn` while the tab is visible.
 *
 * - Mount does not fetch (the server already rendered `initial`); the first poll is one interval later. This holds under
 *   React strict mode, which runs effects twice in development: the effect only fetches at once when the query CHANGED.
 * - The next poll is scheduled when the previous one has finished, so requests never overlap.
 * - Hidden tab: the timer is cleared. Visible again: poll now, then keep the cadence.
 * - A request that hangs is aborted after `timeoutMs`, so it cannot stall polling for ever.
 * - A 401 stops polling (the session is over). Other failures keep the last good data and retry, backing off after three.
 */
export function usePoll<T>({ fetchFn, queryKey, initial, intervalMs = 5000, timeoutMs = 10_000 }: Options<T>): PollResult<T> {
  const firstKey = useRef(queryKey);
  const lastKey = useRef(queryKey);
  const [snap, setSnap] = useState<Snapshot<T> | null>(null);
  const [failing, setFailing] = useState<{ key: string; health: Health }>({ key: queryKey, health: INITIAL_HEALTH });

  useEffect(() => {
    const queryChanged = lastKey.current !== queryKey;
    lastKey.current = queryKey;

    let cancelled = false;
    let inflight = false;
    let health = INITIAL_HEALTH;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const visible = () => document.visibilityState === "visible";

    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (cancelled || health.sessionEnded || !visible()) return;
      timer = setTimeout(() => void poll(), ms);
    };

    const poll = async () => {
      clearTimeout(timer);
      if (cancelled || inflight || health.sessionEnded || !visible()) return;
      inflight = true;
      const own = new AbortController();
      controller = own;
      const abortTimer = setTimeout(() => own.abort(), timeoutMs);
      try {
        const data = await fetchFn(own.signal);
        if (cancelled) return;
        health = afterSuccess();
        setSnap({ key: queryKey, data, health });
        setFailing({ key: queryKey, health });
      } catch (error) {
        if (cancelled) return;
        health = afterFailure(health, error);
        setFailing({ key: queryKey, health });
      } finally {
        clearTimeout(abortTimer);
        inflight = false;
      }
      if (!cancelled) schedule(nextDelayMs(intervalMs, health));
    };

    const onVisibility = () => {
      if (!visible()) clearTimeout(timer);
      else void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    if (queryChanged) void poll();
    else schedule(intervalMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchFn, queryKey, intervalMs, timeoutMs]);

  const data = snap && snap.key === queryKey ? snap.data : queryKey === firstKey.current ? initial : null;
  const health = failing.key === queryKey ? failing.health : INITIAL_HEALTH;
  return { data, state: feedState(health) };
}
