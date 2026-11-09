/**
 * Shared helpers for the QA scripts (scripts/qa/live.ts, scripts/qa/browser.ts).
 *
 * Rules every QA script follows:
 *  - it only targets a local server unless QA_ALLOW_REMOTE=1 (the checks reset the demo);
 *  - every section signs in as its OWN session, and cleans up after itself (its rows, then the
 *    shared demo state back to the seed), so sections never depend on each other;
 *  - it prints pass/fail lines and never prints credentials or connection details.
 */
import { closeDb, getDb, getSql } from "../../src/db/client";
import { runSeed } from "../../src/seed/runner";

export const BASE = process.env.QA_BASE ?? "http://localhost:3000";

/** The QA scripts reset the demo and write rows: never point them at a deployed site by accident. */
export function guardLocalOnly(): void {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
  if (!local && process.env.QA_ALLOW_REMOTE !== "1") {
    console.log("Refusing to run: QA_BASE is not a local address. These checks reset the demo; set QA_ALLOW_REMOTE=1 only if that is what you want.");
    process.exit(2);
  }
  console.log(`QA target: ${BASE}`);
}

// ---- results ---------------------------------------------------------------------------------------
const tally = { passes: 0, failures: 0 };
export function check(name: string, ok: boolean, extra = ""): boolean {
  if (ok) tally.passes++;
  else tally.failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
  return ok;
}
export const noteFailure = (message: string): void => {
  tally.failures++;
  console.log(`FAIL  ${message}`);
};
export const info = (message: string): void => console.log(`INFO  ${message}`);
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Print the totals and set the exit code. */
export function finish(): void {
  console.log(`\n${tally.passes} passed, ${tally.failures} failed`);
  console.log(tally.failures === 0 ? "ALL CHECKS PASSED" : `${tally.failures} CHECK(S) FAILED`);
  process.exitCode = tally.failures === 0 ? 0 : 1;
}
export const failureCount = (): number => tally.failures;

// ---- text helpers ------------------------------------------------------------------------------------
export const visible = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
export const count = (text: string, needle: string): number => text.split(needle).length - 1;

// ---- HTTP sessions (for API-level checks) --------------------------------------------------------------
type Jar = Map<string, string>;
export type Who = { jar: Jar; sid: string };

const absorb = (jar: Jar, res: Response) => {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
const cookieHeader = (jar: Jar) => Array.from(jar).map(([k, v]) => `${k}=${v}`).join("; ");

/** Sign in as the demo user; each call is a NEW session (its own sid). */
export async function signIn(): Promise<Who> {
  const jar: Jar = new Map();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  absorb(jar, csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
    body: new URLSearchParams({ csrfToken, email: "demo@moneysafe.ai", password: process.env.DEMO_PASSWORD ?? "", json: "true", callbackUrl: BASE }),
  });
  absorb(jar, res);
  const s = (await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie: cookieHeader(jar) } })).json()) as { sid?: string };
  return { jar, sid: s.sid ?? "" };
}

export const call = (who: Who | null, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(who ? { cookie: cookieHeader(who.jar) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
export const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json().catch(() => ({}))) as Record<string, unknown>;

// ---- database cleanup ----------------------------------------------------------------------------------
export type Sql = ReturnType<typeof getSql>;
export { closeDb, getDb, getSql, runSeed };

/**
 * Remove everything the given QA sessions created, then put the shared demo state (weights, pending
 * proposal, counter, insights cache, seeded history) back to the seed. Never touches llm_daily_usage.
 */
export async function cleanup(sessions: string[]): Promise<void> {
  const sql = getSql();
  const disputeIds = (await sql<{ id: string }[]>`SELECT id FROM disputes WHERE session_id = ANY(${sessions}) AND NOT is_seed`).map((d) => d.id);
  const orderIds = (await sql<{ id: string }[]>`SELECT id FROM orders WHERE session_id = ANY(${sessions}) AND NOT is_seed`).map((o) => o.id);
  if (disputeIds.length) {
    await sql`DELETE FROM action_executions WHERE dispute_id = ANY(${disputeIds}::uuid[])`;
    await sql`DELETE FROM approval_records WHERE dispute_id = ANY(${disputeIds}::uuid[])`;
    await sql`DELETE FROM dispute_outcomes WHERE dispute_id = ANY(${disputeIds}::uuid[])`;
    await sql`DELETE FROM agent_activity WHERE ref_dispute_id = ANY(${disputeIds}::uuid[])`;
    await sql`DELETE FROM disputes WHERE id = ANY(${disputeIds}::uuid[])`;
  }
  if (orderIds.length) {
    await sql`DELETE FROM agent_activity WHERE ref_order_id = ANY(${orderIds}::uuid[])`;
    await sql`DELETE FROM evidence_artefacts WHERE order_id = ANY(${orderIds}::uuid[])`;
    await sql`DELETE FROM orders WHERE id = ANY(${orderIds}::uuid[])`;
  }
  await sql`DELETE FROM agent_activity WHERE session_id = ANY(${sessions})`;
  await sql`DELETE FROM llm_rate_limits WHERE session_id = ANY(${sessions})`;
  await runSeed(getDb());
  console.log(`cleanup: removed ${orderIds.length} order(s), ${disputeIds.length} dispute(s); shared demo state re-seeded`);
}

/** Wait until the 10-second global-reset cooldown (from a previous reset) has passed. */
export async function waitForResetCooldown(sql: Sql): Promise<void> {
  for (let i = 0; i < 14; i++) {
    const [r] = await sql<{ age: number | null }[]>`SELECT extract(epoch from (now() - max(created_at::timestamptz)))::float AS age FROM agent_activity WHERE tool_name = 'reset_demo_global'`;
    if (r?.age === null || r?.age === undefined || r.age > 11) return;
    await sleep(1000);
  }
}
