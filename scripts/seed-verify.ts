/**
 * Read-only check of the seeded database.  Run with:  npm run db:seed:verify
 * Prints row counts, the order and dispute verification tables, and integrity checks.
 * Exits 1 if anything differs from the spec.
 */
import { closeDb, getSql } from "../src/db/client";
import { SEED_ACTIVITY_PREFIX, SEED_ACTIVITY_SESSION_ID, seedActivityIds } from "../src/seed/activity";
import { seedId } from "../src/seed/ids";
import { computeInsightsFingerprint } from "../src/lib/insights/fingerprint";

const ALL_TABLES = [
  "action_executions",
  "agent_activity",
  "approval_records",
  "dispute_outcomes",
  "disputes",
  "evidence_artefacts",
  "insights_cache",
  "llm_daily_usage",
  "llm_rate_limits",
  "orders",
  "settings",
  "signal_weights",
];

const ORDERS = [
  { key: "SEED-A", score: 0, verdict: "ship" },
  { key: "SEED-B", score: 55, verdict: "verify" },
  { key: "SEED-D-ORD", score: 0, verdict: "ship" },
  { key: "SEED-E-ORD", score: 40, verdict: "verify" },
  { key: "SEED-F", score: 70, verdict: "hold" },
];
const OPEN = [
  { key: "SEED-C", pct: 95, rec: "contest" },
  { key: "SEED-D", pct: 27, rec: "refund" },
  { key: "SEED-E", pct: 44, rec: "contest" },
];
const RESOLVED = { won: 2, lost: 1, refunded: 2 } as const;

let failures = 0;
const mark = (ok: boolean) => {
  if (!ok) failures++;
  return ok ? "PASS" : "FAIL";
};
const pad = (v: unknown, n: number) => String(v).padEnd(n);

async function main(): Promise<void> {
  const sql = getSql();

  console.log("== ROW COUNTS");
  for (const t of ALL_TABLES) {
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)}`;
    console.log(`${pad(t, 22)} ${r?.n}`);
  }

  console.log("\n== SEED ORDERS (risk_score / verdict)");
  const orderRows = await sql<{ id: string; risk_score: number; verdict: string; status: string; used_fallback: boolean }[]>`
    SELECT id, risk_score, verdict, status, used_fallback FROM orders WHERE id IN ${sql(ORDERS.map((o) => seedId("order", o.key)))}`;
  console.log(`${pad("order", 12)}${pad("risk_score", 12)}${pad("verdict", 10)}${pad("status", 10)}result`);
  for (const want of ORDERS) {
    const row = orderRows.find((r) => r.id === seedId("order", want.key));
    const ok = !!row && row.risk_score === want.score && row.verdict === want.verdict && row.used_fallback === false;
    console.log(`${pad(want.key, 12)}${pad(row?.risk_score ?? "missing", 12)}${pad(row?.verdict ?? "-", 10)}${pad(row?.status ?? "-", 10)}${mark(ok)}`);
  }

  console.log("\n== OPEN DISPUTES (win_probability / final_recommendation)");
  const openRows = await sql<
    { id: string; status: string; win_probability: number; win_likelihood_label: string; final_recommendation: string; deadline_offset_hours: number; analyzed: boolean; llm_adjustment: number }[]
  >`SELECT id, status, win_probability::float AS win_probability, win_likelihood_label, final_recommendation,
           deadline_offset_hours, (analysis_computed_at IS NOT NULL) AS analyzed, llm_adjustment::float AS llm_adjustment
    FROM disputes WHERE id IN ${sql(OPEN.map((d) => seedId("dispute", d.key)))}`;
  console.log(`${pad("dispute", 10)}${pad("status", 8)}${pad("win_prob", 10)}${pad("label", 10)}${pad("recommendation", 16)}${pad("deadline+h", 12)}result`);
  for (const want of OPEN) {
    const row = openRows.find((r) => r.id === seedId("dispute", want.key));
    const pct = row ? Math.round(row.win_probability * 100) : -1;
    const ok = !!row && row.status === "open" && pct === want.pct && row.final_recommendation === want.rec && row.analyzed && row.llm_adjustment === 0;
    console.log(`${pad(want.key, 10)}${pad(row?.status ?? "-", 8)}${pad(`${pct}%`, 10)}${pad(row?.win_likelihood_label ?? "-", 10)}${pad(row?.final_recommendation ?? "-", 16)}${pad(row?.deadline_offset_hours ?? "-", 12)}${mark(ok)}`);
  }

  console.log("\n== RESOLVED DISPUTES BY OUTCOME (disputes table / dispute_outcomes table)");
  const byOutcome = await sql<{ outcome: string; n: number }[]>`
    SELECT outcome, count(*)::int AS n FROM disputes WHERE status LIKE 'resolved%' GROUP BY outcome`;
  const byOutcomeRows = await sql<{ outcome: string; n: number }[]>`
    SELECT outcome, count(*)::int AS n FROM dispute_outcomes GROUP BY outcome`;
  for (const [outcome, want] of Object.entries(RESOLVED)) {
    const a = byOutcome.find((r) => r.outcome === outcome)?.n ?? 0;
    const b = byOutcomeRows.find((r) => r.outcome === outcome)?.n ?? 0;
    console.log(`${pad(outcome, 10)}disputes=${a}  dispute_outcomes=${b}  expected=${want}  ${mark(a === want && b === want)}`);
  }
  const [open] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM disputes WHERE status = 'open' AND is_seed`;
  console.log(`${pad("open (seed)", 10)}${open?.n}  expected=3  ${mark(open?.n === 3)}`);

  console.log("\n== INTEGRITY CHECKS");
  const [settingsRow] = await sql<{ n: number; v: number }[]>`
    SELECT count(*)::int AS n, max(merchant_avg_order_value_usd)::float AS v FROM settings`;
  console.log(`${pad("settings row = 85", 46)}${mark(settingsRow?.n === 1 && settingsRow.v === 85)}`);

  const [badPayload] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM evidence_artefacts WHERE jsonb_typeof(payload) <> 'object'`;
  console.log(`${pad("artefact payloads are JSON objects", 46)}${mark(badPayload?.n === 0)}`);

  const [badBreakdown] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM orders WHERE is_seed AND (signal_breakdown IS NULL OR jsonb_typeof(signal_breakdown) <> 'array')`;
  console.log(`${pad("signal_breakdown is a JSON array (all seeds)", 46)}${mark(badBreakdown?.n === 0)}`);

  const [drafts] = await sql<{ with_draft: number; bad: number }[]>`
    SELECT count(*) FILTER (WHERE verification_draft IS NOT NULL)::int AS with_draft,
           count(*) FILTER (WHERE verification_draft IS NOT NULL AND jsonb_typeof(verification_draft) <> 'object')::int AS bad
    FROM orders WHERE is_seed`;
  console.log(`${pad("verification_draft only on 2 verify-first orders", 46)}${mark(drafts?.with_draft === 2 && drafts.bad === 0)}`);

  const [mocked] = await sql<{ n: number; wrong: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT is_mocked OR source <> 'mocked')::int AS wrong
    FROM evidence_artefacts WHERE artefact_type = 'tracking_events'`;
  console.log(`${pad("tracking events labelled mocked", 46)}${mark((mocked?.n ?? 0) > 0 && mocked?.wrong === 0)}`);

  const [w] = await sql<{ n: number; pending: number; counter: number; proposed_ft: number; created: string; c: number; m: number; r: number; h: number; d: number; a: number }[]>`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE proposal_created_at IS NOT NULL)::int AS pending,
           max(resolved_since_last_proposal)::int AS counter,
           max(proposed_first_time_high_value)::int AS proposed_ft,
           max(proposal_created_at) AS created,
           max(country_mismatch)::int AS c, max(first_time_high_value)::int AS m, max(rush_shipping)::int AS r,
           max(high_relative_value)::int AS h, max(disposable_email)::int AS d, max(repeated_attempts)::int AS a
    FROM signal_weights WHERE is_active`;
  console.log(`${pad("one active weights row, pending proposal, counter 0", 46)}${mark(w?.n === 1 && w.pending === 1 && w.counter === 0 && w.proposed_ft === 23)}`);

  const activityIds = seedActivityIds();
  const [act] = await sql<{ n: number; demo: number; kinds: number; simulated: number; orphans: number }[]>`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE session_id = ${SEED_ACTIVITY_SESSION_ID} AND output_summary LIKE ${`${SEED_ACTIVITY_PREFIX}%`})::int AS demo,
           count(DISTINCT step_type)::int AS kinds,
           count(*) FILTER (WHERE status = 'simulated')::int AS simulated,
           count(*) FILTER (WHERE ref_order_id IS NULL AND ref_dispute_id IS NULL)::int AS orphans
    FROM agent_activity WHERE id IN ${sql(activityIds)}`;
  console.log(
    `${pad(`${activityIds.length} seeded activity rows, marked demo data`, 46)}${mark(act?.n === activityIds.length && act.demo === activityIds.length && act.kinds === 3 && act.simulated === 1 && act.orphans === 0)}`,
  );

  // Reset demo and "Restart my demo" each leave ONE audit row (reset_demo_global / reset_demo_session). Visitor activity is
  // expected too. Neither is a seed problem, so they are listed, never failed.
  const extra = await sql<{ tool_name: string; n: number }[]>`
    SELECT tool_name, count(*)::int AS n FROM agent_activity WHERE session_id IS DISTINCT FROM ${SEED_ACTIVITY_SESSION_ID} GROUP BY tool_name ORDER BY tool_name`;
  const resetRows = extra.filter((e) => e.tool_name.startsWith("reset_demo")).reduce((n, e) => n + e.n, 0);
  const otherRows = extra.filter((e) => !e.tool_name.startsWith("reset_demo")).reduce((n, e) => n + e.n, 0);
  console.log(`${pad("non-seed activity rows (tolerated)", 46)}reset_demo*=${resetRows}  visitor=${otherRows}  ${mark(true)}`);

  const [latest] = await sql<{ id: string }[]>`SELECT id FROM dispute_outcomes ORDER BY created_at DESC, id DESC LIMIT 1`;
  const [cnt] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM dispute_outcomes`;
  const [cache] = await sql<{ input_fingerprint: string; used_fallback: boolean; summary: string | null }[]>`
    SELECT input_fingerprint, used_fallback, summary FROM insights_cache LIMIT 1`;
  const expected = computeInsightsFingerprint({
    outcomeCount: cnt?.n ?? 0,
    latestOutcomeId: latest?.id ?? null,
    proposalCreatedAt: w?.created ?? null,
    weights: {
      country_mismatch: w?.c ?? 0,
      first_time_high_value: w?.m ?? 0,
      rush_shipping: w?.r ?? 0,
      high_relative_value: w?.h ?? 0,
      disposable_email: w?.d ?? 0,
      repeated_attempts: w?.a ?? 0,
    },
  });
  console.log(`${pad("insights_cache fingerprint matches live data", 46)}${mark(!!cache?.summary && cache.input_fingerprint === expected)}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    console.error("seed-verify failed:", err instanceof Error ? err.message : err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
