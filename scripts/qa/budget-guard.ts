/**
 * End-to-end check of the LLM budget guard (REQ-NFR-17, task M4-08b) against a RUNNING server.
 *
 *   # 1. see what cap to start the server with
 *   npm run qa:budget -- --print-cap
 *   # 2. start the server (or preview deployment) with that LLM_DAILY_CAP, then
 *   QA_EXPECT_CAP=<that number> npm run qa:budget
 *
 * The daily counter is global and shared by every deployment that uses the same database, and it cannot be reset, so
 * "LLM_DAILY_CAP=3" only means "3 calls" on a day when nothing else has used any. This script therefore works from
 * the real counter: it reads today's usage from the database, spends exactly the remaining budget (a handful of
 * calls), then checks what the product does once the budget is gone:
 *   - orders are still created (201, never a 429 or a 5xx) with their rule-based score;
 *   - their AI text is the rule-based fallback and the order says "AI unavailable";
 *   - an `llm_budget_exceeded` row is in Agent Activity for each of them;
 *   - the counter never goes past the cap;
 *   - the seeded disputes, the Insights page, the Dashboard and Agent Activity still load fully, and loading them
 *     spends no call;
 *   - an unauthenticated call to any /api route still answers 401 (apart from /api/demo/status).
 *
 * It creates demo orders under throw-away sessions and removes them afterwards. It needs the same DATABASE_URL as
 * the server. Against a remote URL it also needs QA_ALLOW_REMOTE=1, and the server must run with DEMO_MODE=true (so
 * that creating an order does not need PayPal).
 */
import { seedId } from "../../src/seed/ids";
import { BASE, call, check, cleanup, closeDb, count, finish, getSql, guardLocalOnly, info, json, noteFailure, signIn, visible, type Who } from "./common";

const MAX_SPEND = 40; // refuse to burn more than this many real model calls to reach the cap

const today = () => new Date().toISOString().slice(0, 10);
const used = async (): Promise<number> => (await getSql()<{ n: number }[]>`SELECT call_count AS n FROM llm_daily_usage WHERE day = ${today()}`)[0]?.n ?? 0;

/** An order that scores above 0 and is "Verify first": it asks the model for an explanation AND a draft (2 calls). */
const RISKY = { itemName: "Budget guard check", amountUsd: 400, shippingMethod: "rush", billingCountry: "US", shippingCountry: "NG", paymentAttemptCount: 3 } as const;

async function main(): Promise<void> {
  const used0 = await used();
  if (process.argv.includes("--print-cap")) {
    console.log(`today's global model calls so far (UTC ${today()}): ${used0}`);
    console.log(`start the server with LLM_DAILY_CAP=${used0 + 3}   (3 calls of headroom, which is what the task's "cap of 3" means on a day with prior use)`);
    return;
  }

  guardLocalOnly();
  const cap = Number(process.env.QA_EXPECT_CAP);
  if (!Number.isInteger(cap) || cap < 1) {
    noteFailure("set QA_EXPECT_CAP to the LLM_DAILY_CAP the server is running with (run with --print-cap to get a good value)");
    return;
  }
  const remaining = Math.max(0, cap - used0);
  info(`server cap ${cap}; used today ${used0}; budget left ${remaining}`);
  if (remaining > MAX_SPEND) {
    noteFailure(`the server's cap leaves ${remaining} calls; this check would have to spend them all on a real provider. Restart the server with a lower LLM_DAILY_CAP (run with --print-cap).`);
    return;
  }

  const sessions: Who[] = [];
  const fresh = async (): Promise<Who> => {
    const who = await signIn();
    sessions.push(who);
    return who;
  };

  try {
    // ---- spend the remaining budget, each order under its own session (a session may only make 10 calls an hour) ------
    const created: string[] = [];
    let spent = 0;
    for (let i = 0; i < remaining + 4 && (await used()) < cap; i++) {
      const who = await fresh();
      const res = await call(who, "POST", "/api/orders", RISKY);
      const body = await json(res);
      if (res.status !== 201) {
        check(`filling the budget: order ${i + 1} is created (201)`, false, `${res.status} ${JSON.stringify(body).slice(0, 120)}`);
        return;
      }
      created.push(String(body.orderId));
      spent = (await used()) - used0;
    }
    const usedFull = await used();
    check(`the budget was spent: ${spent} call(s) from ${used0} up to the cap`, usedFull === cap || remaining === 0, `used ${usedFull} of ${cap}`);

    // ---- now the budget is gone: 4 more calls' worth of orders ------------------------------------------------------
    const after: Array<{ id: string; status: number; who: Who }> = [];
    for (let i = 0; i < 4; i++) {
      const who = await fresh();
      const res = await call(who, "POST", "/api/orders", RISKY);
      const body = await json(res);
      after.push({ id: String(body.orderId), status: res.status, who });
    }
    check("with the budget gone, every new order is still created: 201, never a 429 or a 5xx", after.every((a) => a.status === 201), after.map((a) => a.status).join(","));

    const sql = getSql();
    const rows = await sql<{ id: string; risk_score: number | null; verdict: string | null; used_fallback: boolean }[]>`
      SELECT id, risk_score, verdict, used_fallback FROM orders WHERE id = ANY(${after.map((a) => a.id)}::uuid[])`;
    check("  ...each has its rule-based risk score and verdict (the score never depended on the model)", rows.length === 4 && rows.every((r) => (r.risk_score ?? 0) > 0 && r.verdict !== null), rows.map((r) => `${r.verdict}/${r.risk_score}`).join(" "));
    check("  ...and is flagged as using the rule-based fallback", rows.length === 4 && rows.every((r) => r.used_fallback));

    const budgetRows = await sql<{ ref_order_id: string; status: string }[]>`
      SELECT ref_order_id, status FROM agent_activity WHERE tool_name = 'llm_budget_exceeded' AND ref_order_id = ANY(${after.map((a) => a.id)}::uuid[])`;
    const orderIdsWithRow = new Set(budgetRows.map((r) => r.ref_order_id));
    check("  ...and every one has an llm_budget_exceeded row in Agent Activity", after.every((a) => orderIdsWithRow.has(a.id)), `${orderIdsWithRow.size} of 4 orders`);
    check("  ...recorded as a fallback, not an error", budgetRows.length > 0 && budgetRows.every((r) => r.status === "fallback"), budgetRows.map((r) => r.status).join(","));

    const detail = visible(await (await call(after[0]!.who, "GET", `/orders/${after[0]!.id}`)).text());
    check("  ...the order page says 'AI unavailable — showing rule-based result.'", detail.includes("AI unavailable"));

    // The activity feed shows the row to the session that caused it.
    const feed = (await json(await call(after[0]!.who, "GET", "/api/activity?page=1&pageSize=20"))) as { entries?: Array<{ toolName: string }> };
    check("  ...and the Agent Activity API returns it", (feed.entries ?? []).some((e) => e.toolName === "llm_budget_exceeded"));

    const usedEnd = await used();
    check(`the counter did not go past the cap (${usedEnd} <= ${cap}) and the four extra orders spent nothing`, usedEnd <= cap && usedEnd === usedFull, `${usedFull} -> ${usedEnd}`);

    // ---- everything that makes no model call keeps working with the budget exhausted ----------------------------------
    const reader = await fresh();
    const before = await used();
    const pages: Array<[string, RegExp]> = [
      [`/disputes/${seedId("dispute", "SEED-C")}`, /95\s?%[\s\S]*Strong|Strong[\s\S]*95\s?%/],
      [`/disputes/${seedId("dispute", "SEED-D")}`, /27\s?%/],
      [`/disputes/${seedId("dispute", "SEED-E")}`, /44\s?%/],
      ["/disputes", /Shared example/],
      ["/insights", /Insights/],
      ["/", /Dashboard/],
      ["/activity", /Agent Activity/],
      [`/orders/${seedId("order", "SEED-B")}`, /Verify/],
    ];
    for (const [path, expect] of pages) {
      const res = await call(reader, "GET", path);
      const text = visible(await res.text());
      check(`with the budget exhausted ${path.replace(/[0-9a-f-]{36}/, "{id}")} loads fully`, res.status === 200 && expect.test(text), `${res.status}`);
    }
    const insightsApi = await call(reader, "GET", "/api/insights");
    check("  ...GET /api/insights -> 200", insightsApi.status === 200);
    check("  ...and none of that spent a model call", (await used()) === before, `${before} -> ${await used()}`);
    const seededNote = visible(await (await call(reader, "GET", `/disputes/${seedId("dispute", "SEED-C")}`)).text());
    check("  ...and a seeded dispute shows no 'AI unavailable' note (its analysis is stored)", count(seededNote, "AI unavailable") === 0);

    // ---- the gate is still closed -------------------------------------------------------------------------------------
    const anon = await Promise.all(["/api/orders", "/api/activity", "/api/dashboard", "/api/insights"].map((p) => call(null, "GET", p)));
    check("unauthenticated /api calls still answer 401 (only /api/demo/status is open)", anon.every((r) => r.status === 401), anon.map((r) => r.status).join(","));
    const st = await call(null, "GET", "/api/demo/status");
    check("  ...and /api/demo/status answers 200 with db 'ok'", st.status === 200 && (await json(st)).db === "ok");
  } finally {
    if (sessions.length) await cleanup(sessions.map((s) => s.sid)).catch(() => noteFailure("cleanup failed"));
    info(`today's counter stays at ${await used().catch(() => "?")} (it cannot be reset; it starts again at 00:00 UTC)`);
  }
}

main()
  .catch((err: unknown) => noteFailure(`unexpected error: ${(err instanceof Error ? err.message : String(err)).slice(0, 240)}`))
  .finally(async () => {
    await closeDb().catch(() => undefined);
    finish();
  });
