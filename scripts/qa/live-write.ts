/**
 * The live-write error path (task M4-09, "Live write error"): with DEMO_MODE=false, approving a REAL (non-seed, non-demo)
 * dispute goes to PayPal; when that fails the error must surface, a Retry must be offered, and the retry must reuse the
 * same approval, the same execution and the same PayPal-Request-Id.
 *
 *   npm run qa:livewrite          (the server must run with DEMO_MODE=false, the default in .env.local)
 *
 * The sandbox cannot hand this app a dispute, so the script takes a Start-demo copy and turns it into a real-looking
 * one: not demo, linked to a PayPal dispute id that does not exist. PayPal answers the provide-evidence call with an
 * error. Nothing is created at PayPal. The session's rows are removed afterwards.
 */
import { BASE, call, check, cleanup, closeDb, count, finish, getSql, guardLocalOnly, info, json, noteFailure, signIn, visible } from "./common";
import { seedId } from "../../src/seed/ids";

async function main(): Promise<void> {
  guardLocalOnly();
  const status = (await json(await call(null, "GET", "/api/demo/status"))) as { demoMode?: boolean };
  if (status.demoMode !== false) {
    noteFailure("the server runs with DEMO_MODE=true, which simulates every write; restart it without that override");
    return;
  }
  const me = await signIn();
  const sql = getSql();
  try {
    const start = (await json(await call(me, "POST", "/api/demo/start"))) as { copies?: Array<{ seedDisputeId: string; disputeId: string }> };
    const id = start.copies?.find((c) => c.seedDisputeId === seedId("dispute", "SEED-C"))?.disputeId ?? "";
    check("a Start-demo copy of SEED-C exists", id.length === 36);
    await sql`UPDATE disputes SET is_demo = false, paypal_dispute_id = 'PP-D-QA-0001' WHERE id = ${id}`;
    check("  ...turned into a real (non-demo) dispute linked to a PayPal dispute id", (await sql`SELECT 1 FROM disputes WHERE id = ${id} AND NOT is_demo AND NOT is_seed`).length === 1);

    const page0 = visible(await (await call(me, "GET", `/disputes/${id}`)).text());
    check("its page no longer says the action is simulated", !/Nothing is sent to PayPal/.test(page0));

    const t0 = Date.now();
    const first = await call(me, "POST", `/api/disputes/${id}/approve`, { action: "submit_evidence" });
    const firstBody = await json(first);
    check("Approve goes to PayPal and the failure is reported, not hidden (not a 2xx, not 'executed')", first.status >= 400 && firstBody.status !== "executed", `${first.status} ${JSON.stringify(firstBody).slice(0, 140)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check("  ...the message names a PayPal problem", /paypal/i.test(String(firstBody.message ?? firstBody.error ?? "")), String(firstBody.message ?? firstBody.error ?? "").slice(0, 100));

    const rows = await sql<{ approvals: number; executions: number; executed: number; request_id: string }[]>`
      SELECT (SELECT count(*) FROM approval_records WHERE dispute_id = ${id})::int AS approvals,
             (SELECT count(*) FROM action_executions WHERE dispute_id = ${id})::int AS executions,
             (SELECT count(*) FROM action_executions WHERE dispute_id = ${id} AND executed_at IS NOT NULL)::int AS executed,
             (SELECT paypal_request_id FROM action_executions WHERE dispute_id = ${id} LIMIT 1) AS request_id`;
    const r1 = rows[0]!;
    check("  ...one approval and one execution are stored, and the execution is NOT marked done", r1.approvals === 1 && r1.executions === 1 && r1.executed === 0, JSON.stringify({ ...r1, request_id: r1.request_id ? "(set)" : "(none)" }));

    const failedRows = await sql<{ status: string }[]>`SELECT status FROM agent_activity WHERE ref_dispute_id = ${id} AND step_type = 'paypal_api'`;
    check("  ...Agent Activity has a paypal_api row with status error", failedRows.some((a) => a.status === "error"), failedRows.map((a) => a.status).join(","));
    const d1 = (await sql<{ status: string; outcome: string | null }[]>`SELECT status, outcome FROM disputes WHERE id = ${id}`)[0]!;
    check("  ...the dispute is still open with no outcome", d1.status !== undefined && !d1.status.startsWith("resolved") && d1.outcome === null, `${d1.status}`);

    const page1 = visible(await (await call(me, "GET", `/disputes/${id}`)).text());
    check("  ...its page offers a Retry (the approved action is waiting to be sent again)", /Retry/i.test(page1), /Retry/i.test(page1) ? "" : page1.slice(page1.indexOf("Approve") - 40, page1.indexOf("Approve") + 160));

    // Retry: same approval, same execution, same request id.
    const second = await call(me, "POST", `/api/disputes/${id}/approve`, { action: "submit_evidence" });
    const secondBody = await json(second);
    const r2 = (await sql<{ approvals: number; executions: number; request_id: string }[]>`
      SELECT (SELECT count(*) FROM approval_records WHERE dispute_id = ${id})::int AS approvals,
             (SELECT count(*) FROM action_executions WHERE dispute_id = ${id})::int AS executions,
             (SELECT paypal_request_id FROM action_executions WHERE dispute_id = ${id} LIMIT 1) AS request_id`)[0]!;
    check("Retry is sent to PayPal again and fails the same way", second.status >= 400 && secondBody.status !== "executed", `${second.status}`);
    check("  ...it reused the stored approval and execution (still 1 and 1) and the SAME PayPal-Request-Id", r2.approvals === 1 && r2.executions === 1 && r2.request_id === r1.request_id);
    const attempts = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agent_activity WHERE ref_dispute_id = ${id} AND step_type = 'paypal_api' AND status = 'error'`)[0]!.n;
    check("  ...and each attempt is logged (2 error rows)", attempts === 2, `${attempts}`);
    info(`only the failure path was exercised; the success path of a live write needs a real PayPal dispute, which the sandbox cannot give this app (covered by executor.test.ts with a mocked PayPal)`);
    void BASE;
    void count;
  } finally {
    await cleanup([me.sid]).catch(() => noteFailure("cleanup failed"));
  }
}

main()
  .catch((err: unknown) => noteFailure(`unexpected error: ${(err instanceof Error ? err.message : String(err)).slice(0, 240)}`))
  .finally(async () => {
    await closeDb().catch(() => undefined);
    finish();
  });
