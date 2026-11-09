/**
 * The in-flight guard for dispute analysis (fix 3).
 *
 * `disputes.analysis_computed_at` is the cache marker: null means "not analysed", a timestamp
 * means "analysed". To make sure only ONE request spends model budget for a dispute, a request
 * first CLAIMS the dispute by atomically writing a claim token into that column:
 *
 *     pending:<ISO time>|<random id>
 *
 * Exactly one UPDATE can succeed (`WHERE analysis_computed_at IS NULL` or the existing claim is
 * stale). The winner analyses and then replaces the token with the real timestamp; everyone else
 * waits and returns the winner's saved result. If the winner fails it releases the claim (sets it
 * back to null); if it dies silently the claim goes stale and the next request takes it over.
 *
 * A claim is NOT an analysis: every reader treats it as "not analysed yet".
 */

export const CLAIM_PREFIX = "pending:";
/** The ISO timestamp inside a claim token is always 24 characters, starting right after the prefix. */
export const CLAIM_TIME_START = CLAIM_PREFIX.length + 1; // SQL substr() is 1-based
export const CLAIM_TIME_LENGTH = 24;

/**
 * A claim older than this is considered abandoned. It is well above the worst-case analysis time
 * (32 s of model calls) and above the 60 s a function may run, so a live winner is never robbed.
 */
export const CLAIM_STALE_MS = 90_000;

export function newClaimToken(now: Date, id: string): string {
  return `${CLAIM_PREFIX}${now.toISOString()}|${id}`;
}

export function isClaim(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(CLAIM_PREFIX);
}

/** True when the dispute really has an analysis (a timestamp, not a claim, not null). */
export function isAnalysed(value: string | null | undefined): value is string {
  return typeof value === "string" && value !== "" && !isClaim(value);
}

/** The time a claim was taken, or null if the value is not a well-formed claim. */
export function claimTakenAt(value: string | null | undefined): Date | null {
  if (!isClaim(value)) return null;
  const iso = (value as string).slice(CLAIM_PREFIX.length, CLAIM_PREFIX.length + CLAIM_TIME_LENGTH);
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** An unparseable claim counts as stale: it can never be completed by anyone. */
export function isStaleClaim(value: string | null | undefined, now: Date): boolean {
  if (!isClaim(value)) return false;
  const taken = claimTakenAt(value);
  return taken === null || now.getTime() - taken.getTime() > CLAIM_STALE_MS;
}
