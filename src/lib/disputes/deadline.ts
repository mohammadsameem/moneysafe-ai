/**
 * Dispute deadlines (REQ-DIS-01, REQ-DIS-02). Pure.
 *
 * Open SEED disputes store a deadline OFFSET in hours instead of a fixed time, and the deadline is
 * computed from the current time on every read, so the demo never shows an expired seed dispute.
 */

export const URGENT_BELOW_HOURS = 48;
const HOUR_MS = 3_600_000;

export interface DeadlineSource {
  isSeed: boolean;
  deadlineOffsetHours: number | null;
  deadlineAt: string;
}

/** The deadline to show, as an ISO string. */
export function computeDeadline(row: DeadlineSource, now: Date): string {
  if (row.isSeed && row.deadlineOffsetHours !== null) {
    return new Date(now.getTime() + row.deadlineOffsetHours * HOUR_MS).toISOString();
  }
  return row.deadlineAt;
}

export interface Countdown {
  /** "2d 23h", "5h 12m", "42m", or "Overdue". */
  text: string;
  /** True when less than 48 hours remain, including overdue (REQ-DIS-02: shown in red). */
  urgent: boolean;
  overdue: boolean;
  /** Whole milliseconds remaining; negative when overdue. NaN input yields an overdue, urgent result. */
  remainingMs: number;
}

export function formatCountdown(deadlineIso: string, now: Date): Countdown {
  const deadline = new Date(deadlineIso).getTime();
  if (Number.isNaN(deadline)) return { text: "Unknown", urgent: true, overdue: false, remainingMs: Number.NaN };

  const remainingMs = deadline - now.getTime();
  if (remainingMs <= 0) return { text: "Overdue", urgent: true, overdue: true, remainingMs };

  const minutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  const text = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${Math.max(1, mins)}m`;
  return { text, urgent: remainingMs < URGENT_BELOW_HOURS * HOUR_MS, overdue: false, remainingMs };
}
