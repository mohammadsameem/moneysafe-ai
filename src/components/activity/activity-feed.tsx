"use client";

import { useCallback, useEffect, useState } from "react";
import { DemoBadge, SimulatedBadge } from "@/components/badges";
import { FEED_STATUS_TEXT, PollHttpError } from "@/lib/activity/poll-state";
import { usePoll } from "@/lib/activity/polling";
import type { ActivityEntry, ActivityPage } from "@/lib/activity/queries";

const STEP: Record<ActivityEntry["stepType"], { icon: string; label: string }> = {
  paypal_api: { icon: "P", label: "PayPal" },
  llm_call: { icon: "AI", label: "AI" },
  rule_engine: { icon: "R", label: "Rules" },
  merchant_action: { icon: "M", label: "You" },
};
const STATUS_STYLE: Record<ActivityEntry["status"], string> = {
  success: "border-green-300 bg-green-50 text-green-900",
  error: "border-red-300 bg-red-50 text-red-900",
  fallback: "border-amber-300 bg-amber-50 text-amber-900",
  simulated: "border-sky-300 bg-sky-50 text-sky-900",
};
const STEP_TYPES = ["paypal_api", "llm_call", "rule_engine", "merchant_action"] as const;
const STATUSES = ["success", "error", "fallback", "simulated"] as const;

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }).format(new Date(iso)) + " UTC";
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

interface Props {
  initial: ActivityPage;
  /** Fixed filters, e.g. one order's or one dispute's entries (REQ-AA-03). */
  refOrderId?: string;
  refDisputeId?: string;
  /** Show the step-type / status filter bar and "Load more" (the full /activity page). */
  full?: boolean;
  pollMs?: number;
  title?: string;
}

/**
 * Agent activity, newest first, refreshed every 5 seconds (REQ-AA-02). Each row shows the step
 * type, tool, time, duration and status, and expands to its input and output summaries.
 *
 * Polling behaviour:
 * - Uses the server `initial` data immediately (no mount fetch)
 * - Polls every 5s when the tab is visible, pauses when hidden, resumes immediately when visible
 * - On first poll failure: shows "Refresh delayed, retrying" (quiet transient state)
 * - On 3rd consecutive failure: shows "Could not refresh data" (persistent error)
 * - On 401: shows "Your session has ended; sign in again" and stops polling
 * - Keeps the last good data visible during transient errors
 */
export function ActivityFeed({ initial, refOrderId, refDisputeId, full = false, pollMs = 5000, title = "Agent activity" }: Props) {
  const [older, setOlder] = useState<ActivityEntry[]>([]);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [page, setPage] = useState(1);
  const [stepType, setStepType] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  const query = useCallback(
    (p: number) => {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(initial.pageSize) });
      if (refOrderId) qs.set("refOrderId", refOrderId);
      if (refDisputeId) qs.set("refDisputeId", refDisputeId);
      if (stepType) qs.set("stepType", stepType);
      if (status) qs.set("status", status);
      return `/api/activity?${qs.toString()}`;
    },
    [initial.pageSize, refOrderId, refDisputeId, stepType, status],
  );

  const queryKey = query(1);
  const fetchFn = useCallback(
    async (signal: AbortSignal): Promise<ActivityPage> => {
      const response = await fetch(queryKey, { cache: "no-store", signal });
      if (!response.ok) throw new PollHttpError(response.status);
      return (await response.json()) as ActivityPage;
    },
    [queryKey],
  );

  // No request at mount (the server rendered `initial`); then one poll per interval while the tab is visible.
  const poll = usePoll<ActivityPage>({ fetchFn, queryKey, initial, intervalMs: pollMs });
  const loading = poll.data === null; // a filter just changed and its first answer is not back yet
  const entries = poll.data?.entries ?? [];

  // Filters changed: start again from page 1.
  useEffect(() => {
    setOlder([]);
    setPage(1);
  }, [stepType, status]);

  async function loadMore() {
    const next = page + 1;
    const response = await fetch(query(next), { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as ActivityPage;
    setOlder((o) => [...o, ...body.entries]);
    setHasMore(body.hasMore);
    setPage(next);
  }

  const seen = new Set(entries.map((e) => e.id));
  const rows = [...entries, ...older.filter((e) => !seen.has(e.id))];

  return (
    <section aria-labelledby={`activity-${refOrderId ?? refDisputeId ?? "all"}`} className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`activity-${refOrderId ?? refDisputeId ?? "all"}`} className="font-medium">{title}</h2>
        <p className={`text-xs ${poll.state === "error" || poll.state === "session-ended" ? "text-amber-800" : "text-muted-foreground"}`} aria-live="polite" data-feed-state={poll.state}>{FEED_STATUS_TEXT[poll.state]}</p>
      </div>

      {full ? (
        <div className="mt-3 flex flex-wrap gap-3" role="group" aria-label="Filters">
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Step</span>
            <select value={stepType} onChange={(e) => setStepType(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">All</option>
              {STEP_TYPES.map((s) => (
                <option key={s} value={s}>{STEP[s].label}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {loading ? (
        <p className="mt-4 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground" role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="mt-4 divide-y">
          {rows.map((e) => (
            <li key={e.id}>
              <details className="group py-2">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold">{STEP[e.stepType].icon}</span>
                  <span className="sr-only">{STEP[e.stepType].label} step:</span>
                  <span className="font-mono text-xs">{e.toolName}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[e.status]}`}>{e.status}</span>
                  {e.status === "simulated" ? <SimulatedBadge /> : null}
                  {e.isDemo ? <DemoBadge /> : null}
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    <time dateTime={e.createdAt}>{when(e.createdAt)}</time> · {duration(e.durationMs)}
                  </span>
                </summary>
                <dl className="mt-2 grid gap-2 rounded-md bg-muted/40 p-3 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-medium text-muted-foreground">Input</dt>
                    <dd className="mt-0.5 break-words">{e.inputSummary}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-muted-foreground">Output</dt>
                    <dd className="mt-0.5 break-words">{e.outputSummary}</dd>
                  </div>
                </dl>
              </details>
            </li>
          ))}
        </ul>
      )}

      {full && hasMore ? (
        <button type="button" onClick={() => void loadMore()} className="mt-3 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Load more
        </button>
      ) : null}
    </section>
  );
}
