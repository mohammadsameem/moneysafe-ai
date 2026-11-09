/**
 * Live API checks against the running dev server and the real database.
 *
 *   npm run qa:live                 every section, one after another
 *   npm run qa:live -- restart      one section (loop, propose, insights-read, insights-flow,
 *                                   insights-page, dashboard, restart, reset, verify)
 *
 * Each section signs in as its OWN session (and some use a second one), and cleans up after
 * itself: its rows are deleted and the shared demo state (weights, pending proposal, counter,
 * insights cache, seeded history) is re-seeded. So no section depends on another, and they pass
 * when run together. Needs DEMO_MODE=true on the server. The `reset` section resets the whole demo
 * (that is what it tests), so run it when nobody else is using the database.
 *
 * Some sections make real model calls (a weight proposal, an Insights summary); they fall back
 * cleanly if the model is unavailable, and the checks say which path ran.
 */
import { seedId } from "../../src/seed/ids";
import { BASE, call, check, cleanup, closeDb, count, finish, getDb, getSql, guardLocalOnly, json, noteFailure, signIn, visible, waitForResetCooldown, type Sql, type Who } from "./common";

const WANT = process.argv[2] ?? "all";
const C = seedId("dispute", "SEED-C");
const D = seedId("dispute", "SEED-D");
const E = seedId("dispute", "SEED-E");

interface Ctx {
  me: Who;
  sql: ReturnType<typeof getSql>;
  startDemo: () => Promise<Record<string, string>>;
}

const SECTIONS: Record<string, (ctx: Ctx) => Promise<void>> = {};

// ---- M4-01: the outcome hook is bound to the learning loop -----------------------------------
SECTIONS.loop = async ({ me, sql, startDemo }) => {
  const copies = await startDemo();
  const [seedWeights] = await sql`SELECT resolved_since_last_proposal AS n, proposal_created_at, proposed_first_time_high_value AS p FROM signal_weights WHERE is_active`;
  check("seeded state: counter 0 and the seeded proposal (first-time high value -> 23) is pending", seedWeights?.n === 0 && seedWeights?.p === 23 && seedWeights?.proposal_created_at !== null);
  const pendingAt = seedWeights?.proposal_created_at;

  // Bring the shared counter to 4, then make the 5th outcome with a real refund approval.
  await sql`UPDATE signal_weights SET resolved_since_last_proposal = 4 WHERE is_active`;
  const refund = await json(await call(me, "POST", `/api/disputes/${copies[D]}/approve`, { action: "accept_claim" }));
  check("5th outcome (a refund on my SEED-D copy) -> executed, outcome recorded", refund.status === "executed");
  const [after] = await sql`SELECT resolved_since_last_proposal AS n, proposal_created_at, proposed_first_time_high_value AS p FROM signal_weights WHERE is_active`;
  check("  ...counter is 5 (not reset) because a proposal was already pending", after?.n === 5, `counter=${after?.n}`);
  check("  ...the pending proposal is untouched", after?.proposal_created_at === pendingAt && after?.p === 23);
  const acts = await sql<{ step_type: string; tool_name: string; status: string }[]>`SELECT step_type, tool_name, status FROM agent_activity WHERE session_id = ${me.sid} AND ref_dispute_id = ${copies[D]} ORDER BY created_at`;
  check("  ...a rule_engine 'proposal_skipped_pending' row was logged", acts.some((a) => a.step_type === "rule_engine" && a.tool_name === "proposal_skipped_pending"), acts.map((a) => a.tool_name).join(","));
  check("  ...no weight_proposal model call was made", !acts.some((a) => a.tool_name === "weight_proposal"));

  // 6th outcome via Simulate outcome (Won on SEED-C copy): the counter counts on, nothing else happens.
  await call(me, "POST", `/api/disputes/${copies[C]}/approve`, { action: "submit_evidence" });
  const won = await call(me, "POST", `/api/disputes/${copies[C]}/simulate-outcome`, { outcome: "won" });
  check("6th outcome (Simulate outcome Won) -> 200 recorded", won.status === 200);
  const [six] = await sql`SELECT resolved_since_last_proposal AS n FROM signal_weights WHERE is_active`;
  check("  ...counter is 6", six?.n === 6, `counter=${six?.n}`);
};

// ---- M4-01: the 5th outcome with NO proposal pending asks the model (real provider) ----------
SECTIONS.propose = async ({ me, sql, startDemo }) => {
  const copies = await startDemo();
  await sql`UPDATE signal_weights SET proposed_country_mismatch = NULL, proposed_first_time_high_value = NULL, proposed_rush_shipping = NULL, proposed_high_relative_value = NULL, proposed_disposable_email = NULL, proposed_repeated_attempts = NULL, proposal_reasoning = NULL, proposal_created_at = NULL, resolved_since_last_proposal = 4 WHERE is_active`;
  const refund = await json(await call(me, "POST", `/api/disputes/${copies[D]}/approve`, { action: "accept_claim" }));
  check("5th outcome with nothing pending -> executed", refund.status === "executed");
  const [w] = await sql`SELECT resolved_since_last_proposal AS n, proposal_created_at AS at, country_mismatch AS cm, first_time_high_value AS ft, rush_shipping AS rs, high_relative_value AS hr, disposable_email AS de, repeated_attempts AS ra,
      proposed_country_mismatch AS pcm, proposed_first_time_high_value AS pft, proposed_rush_shipping AS prs, proposed_high_relative_value AS phr, proposed_disposable_email AS pde, proposed_repeated_attempts AS pra, proposal_reasoning AS why FROM signal_weights WHERE is_active`;
  const acts = await sql<{ step_type: string; tool_name: string; status: string }[]>`SELECT step_type, tool_name, status FROM agent_activity WHERE session_id = ${me.sid} ORDER BY created_at`;
  const names = acts.map((a) => `${a.tool_name}:${a.status}`);
  check("  ...the live weights did NOT change (a proposal is never applied by itself)", w?.cm === 20 && w?.ft === 20 && w?.rs === 15 && w?.hr === 20 && w?.de === 15 && w?.ra === 10);
  if (w?.at) {
    const live = [20, 20, 15, 20, 15, 10];
    const proposed = [w.pcm, w.pft, w.prs, w.phr, w.pde, w.pra] as number[];
    check("  ...a model call was made and a proposal stored, counter reset to 0", acts.some((a) => a.tool_name === "weight_proposal" && a.step_type === "llm_call") && w.n === 0, names.join(" | "));
    check("  ...every proposed weight is within +/-3 of live and inside [5, 30]", proposed.every((p, i) => Math.abs(p - live[i]!) <= 3 && p >= 5 && p <= 30), proposed.join(","));
    check("  ...it has reasoning and a weight_proposal_created row", typeof w.why === "string" && w.why.length > 20 && acts.some((a) => a.tool_name === "weight_proposal_created"));
    console.log(`INFO  proposal stored; proposed = ${proposed.join(",")}`);
  } else {
    check("  ...the model was unavailable: no proposal, counter stays 5, a fallback row explains why", w?.n === 5 && acts.some((a) => a.tool_name === "proposal_skipped_ai_unavailable"), names.join(" | "));
    console.log("INFO  the model was unavailable in this run (rule-based path)");
  }
};

const dailyCalls = async (sql: ReturnType<typeof getSql>): Promise<number> => {
  const day = new Date().toISOString().slice(0, 10);
  return (await sql<{ n: number }[]>`SELECT call_count AS n FROM llm_daily_usage WHERE day = ${day}`)[0]?.n ?? 0;
};
const activeWeights = async (sql: ReturnType<typeof getSql>) =>
  (await sql`SELECT country_mismatch AS cm, first_time_high_value AS ft, rush_shipping AS rs, high_relative_value AS hr, disposable_email AS de, repeated_attempts AS ra, resolved_since_last_proposal AS n, proposal_created_at AS at, proposed_first_time_high_value AS pft FROM signal_weights WHERE is_active`)[0];

// ---- M4-02: GET /api/insights is read-only and model-free; approve / reject are guarded ---------
SECTIONS["insights-read"] = async ({ me, sql }) => {
  check("GET /api/insights without a session -> 401", (await call(null, "GET", "/api/insights")).status === 401);
  check("POST approve-weights without a session -> 401", (await call(null, "POST", "/api/insights/approve-weights", {})).status === 401);
  check("POST reject-weights without a session -> 401", (await call(null, "POST", "/api/insights/reject-weights", {})).status === 401);

  const usageBefore = await dailyCalls(sql);
  const first = await call(me, "GET", "/api/insights");
  const view = await json(first);
  const second = await json(await call(me, "GET", "/api/insights"));
  check("GET /api/insights -> 200", first.status === 200);
  const weights = view.weights as { signal: string; current: number; baseline: number; delta: number }[];
  check("  ...six weights at their baseline (delta 0)", weights.length === 6 && weights.every((w) => w.delta === 0 && w.current === w.baseline));
  const proposal = view.proposal as { createdAt: string; reasoning: string; isDemo: boolean; changes: { signal: string; current: number; proposed: number; delta: number }[] } | null;
  const ft = proposal?.changes.find((c) => c.signal === "first_time_high_value");
  check("  ...the seeded proposal is pending: first-time high value 20 -> 23, flagged as demo data", proposal?.isDemo === true && ft?.current === 20 && ft?.proposed === 23 && ft?.delta === 3);
  const outcomes = view.outcomes as { total: number; won: number; lost: number; refunded: number; seeded: number; includesDemoData: boolean };
  check("  ...H1-H5 in the breakdown: 2 won, 1 lost, 2 refunded", outcomes.total === 5 && outcomes.won === 2 && outcomes.lost === 1 && outcomes.refunded === 2 && outcomes.includesDemoData === true);
  const summary = view.summary as { source: string; usedFallback: boolean; note: string | null; text: string };
  check("  ...the seeded summary is served from the cache (not a fallback, no note)", summary.source === "cached" && summary.usedFallback === false && summary.note === null && summary.text.includes("Of the 5 resolved disputes"));
  check("  ...two GETs: identical, and 0 model calls (the day's usage counter did not move, no llm_call rows)", JSON.stringify(view) === JSON.stringify(second) && (await dailyCalls(sql)) === usageBefore && (await sql`SELECT count(*)::int AS n FROM agent_activity WHERE session_id = ${me.sid} AND step_type = 'llm_call'`)[0]?.n === 0);

  const w0 = await activeWeights(sql);
  check("approve-weights with a bad body -> 400", (await call(me, "POST", "/api/insights/approve-weights", { nope: 1 })).status === 400);
  const wrong = await call(me, "POST", "/api/insights/approve-weights", { proposalCreatedAt: "2020-01-01T00:00:00.000Z" });
  check("approve-weights for a proposal that is not the pending one -> 409 proposal_changed", wrong.status === 409 && (await json(wrong)).error === "proposal_changed");
  const wrongReject = await call(me, "POST", "/api/insights/reject-weights", { proposalCreatedAt: "2020-01-01T00:00:00.000Z" });
  check("reject-weights for a proposal that is not the pending one -> 409 proposal_changed", wrongReject.status === 409);
  const w1 = await activeWeights(sql);
  check("  ...nothing changed", JSON.stringify(w0) === JSON.stringify(w1) && w1?.pft === 23);
};

// ---- M4-02: the write paths refresh the summary; approve applies; reject keeps the counter -------
SECTIONS["insights-flow"] = async ({ me, sql, startDemo }) => {
  const copies = await startDemo();
  await call(me, "POST", `/api/disputes/${copies[C]}/approve`, { action: "submit_evidence" });
  const usage0 = await dailyCalls(sql);
  const won = await call(me, "POST", `/api/disputes/${copies[C]}/simulate-outcome`, { outcome: "won" });
  check("Simulate outcome Won -> 200", won.status === 200);
  const acts = (await sql<{ tool_name: string; status: string }[]>`SELECT tool_name, status FROM agent_activity WHERE session_id = ${me.sid} AND step_type = 'llm_call'`).map((a) => `${a.tool_name}:${a.status}`);
  check("  ...the outcome (a write path) refreshed the summary with exactly 1 model call", acts.filter((a) => a.startsWith("insights_summary")).length >= 1 && (await dailyCalls(sql)) - usage0 === 1, acts.join(","));

  const usage1 = await dailyCalls(sql);
  const view = await json(await call(me, "GET", "/api/insights"));
  const outcomes = view.outcomes as { total: number; won: number; simulated: number };
  const summary = view.summary as { source: string; usedFallback: boolean; text: string };
  check("  ...GET /api/insights now shows 6 outcomes (1 simulated) and a cached summary, with 0 further model calls", outcomes.total === 6 && outcomes.won === 3 && outcomes.simulated === 1 && summary.source === "cached" && (await dailyCalls(sql)) === usage1);
  console.log(`INFO  summary usedFallback=${summary.usedFallback} (${summary.text.length} chars)`);

  // Approve the seeded pending proposal.
  const pending = (view.proposal as { createdAt: string } | null)?.createdAt ?? "";
  const before = await activeWeights(sql);
  const approved = await call(me, "POST", "/api/insights/approve-weights", { proposalCreatedAt: pending });
  check("approve-weights -> 200 applied", approved.status === 200 && (await json(approved)).status === "applied");
  const after = await activeWeights(sql);
  check("  ...first-time high value is now 23, the others unchanged, proposal cleared, counter 0", after?.ft === 23 && after?.cm === before?.cm && after?.rs === before?.rs && after?.at === null && after?.n === 0, JSON.stringify(after));
  const again = await call(me, "POST", "/api/insights/approve-weights", { proposalCreatedAt: pending });
  check("  ...approving again -> 409 no_proposal (idempotent)", again.status === 409 && (await json(again)).error === "no_proposal");
  check("  ...logged as a merchant_action", (await sql`SELECT count(*)::int AS n FROM agent_activity WHERE session_id = ${me.sid} AND tool_name = 'approve_weight_change' AND step_type = 'merchant_action'`)[0]?.n === 1);
  const afterView = await json(await call(me, "GET", "/api/insights"));
  const w = (afterView.weights as { signal: string; current: number; delta: number }[]).find((x) => x.signal === "first_time_high_value");
  check("  ...GET /api/insights: the weight shows 23 (+3 against the baseline) and no proposal is pending", w?.current === 23 && w?.delta === 3 && afterView.proposal === null && (afterView.summary as { source: string }).source === "cached");

  // A new order is scored with the new weight.
  const created = await json(await call(me, "POST", "/api/orders", { itemName: "Live M4 check", amountUsd: 300, shippingMethod: "rush", billingCountry: "US", shippingCountry: "US" }));
  const order = (await sql<{ signal_breakdown: { signal: string; weight: number; active: boolean }[]; risk_score: number }[]>`SELECT signal_breakdown, risk_score FROM orders WHERE id = ${String(created.orderId)}`)[0];
  const ftSignal = order?.signal_breakdown.find((s) => s.signal === "first_time_high_value");
  check("a new order is scored with the approved weight (first_time_high_value = 23)", ftSignal?.weight === 23, `weight=${ftSignal?.weight} score=${order?.risk_score}`);

  // Reject path: stage a proposal, reject it, the live weights and the counter stay.
  await sql`UPDATE signal_weights SET proposed_country_mismatch = 23, proposed_first_time_high_value = 23, proposed_rush_shipping = 15, proposed_high_relative_value = 20, proposed_disposable_email = 15, proposed_repeated_attempts = 10, proposal_reasoning = 'Live test proposal.', proposal_created_at = '2026-11-09T00:00:00.000Z', resolved_since_last_proposal = 3 WHERE is_active`;
  const rejected = await call(me, "POST", "/api/insights/reject-weights", { proposalCreatedAt: "2026-11-09T00:00:00.000Z" });
  check("reject-weights -> 200 rejected", rejected.status === 200 && (await json(rejected)).status === "rejected");
  const rw = await activeWeights(sql);
  check("  ...proposal cleared, live weights unchanged (country mismatch still 20), counter NOT reset (3)", rw?.at === null && rw?.cm === 20 && rw?.ft === 23 && rw?.n === 3, JSON.stringify(rw));
  check("  ...logged as a merchant_action", (await sql`SELECT count(*)::int AS n FROM agent_activity WHERE session_id = ${me.sid} AND tool_name = 'reject_weight_change'`)[0]?.n === 1);
};

// ---- M4-03: the Insights page renders the seeded state, and updates after a decision -------------
SECTIONS["insights-page"] = async ({ me, sql }) => {
  const anon = await call(null, "GET", "/insights");
  check("/insights without a session redirects to /login", anon.status >= 300 && anon.status < 400 && (anon.headers.get("location") ?? "").includes("/login"));

  const usage0 = await dailyCalls(sql);
  const res = await call(me, "GET", "/insights");
  const html = await res.text();
  const t = visible(html);
  check("/insights -> 200", res.status === 200);
  check("  ...signal weights table: six signals with current, starting and change columns", t.includes("Signal weights") && t.includes("Billing and shipping countries differ") && t.includes("Repeated payment attempts") && count(html, "<tr") >= 7 + 7);
  check("  ...the label 'Explainable risk signals + AI reasoning' is shown", t.includes("Explainable risk signals + AI reasoning"));
  check("  ...WeightChangeProposal card: waiting for approval, first-time high value 20 -> 23 (+3), reasoning, Approve and Reject", t.includes("Proposed weight change") && t.includes("Waiting for your approval") && /First-time buyer, high value\s*20\s*23\s*\S*\s*\+3/.test(t) && t.includes("the only loss (H3") && t.includes("Approve change") && /\bReject\b/.test(t));
  check("  ...Demo data badges on the proposal, the outcomes and the summary", count(t, "Demo data") >= 3, `badges=${count(t, "Demo data")}`);
  check("  ...outcome chart: Won 2, Lost 1, Refunded 2, '5 resolved in total'", t.includes("How disputes ended") && /Won\s*2/.test(t) && /Lost\s*1/.test(t) && /Refunded\s*2/.test(t) && t.includes("5 resolved in total"));
  check("  ...the cached summary, with no AI-unavailable note", t.includes("Of the 5 resolved disputes") && !t.includes("AI unavailable"));
  check("  ...one-line notice that weights are shared across the demo", t.includes("Signal weights are shared across the demo"));
  check("  ...no 'trained fraud model' wording", !/trained fraud model|AI fraud detection/i.test(t));
  check("  ...opening the page made 0 model calls", (await dailyCalls(sql)) === usage0);
  check("the sidebar links to /insights", (await (await call(me, "GET", "/")).text()).includes('href="/insights"'));

  const view = await json(await call(me, "GET", "/api/insights"));
  const at = (view.proposal as { createdAt: string }).createdAt;
  await call(me, "POST", "/api/insights/approve-weights", { proposalCreatedAt: at });
  const after = visible(await (await call(me, "GET", "/insights")).text());
  const row = /First-time buyer, high value first_time_high_value[^A-Z]{0,60}/.exec(after)?.[0] ?? "(row not found)";
  check("after approving: the proposal card is gone and the weights table shows 23 with +3", !after.includes("Proposed weight change") && /first_time_high_value\s*23\s*20\s*\S*\s*\+3/.test(after), row);
};

// ---- M4-04: the Dashboard shows the seeded state, then updates from this session's actions -------
SECTIONS.dashboard = async ({ me, sql, startDemo }) => {
  const FEE = Number(process.env.CHARGEBACK_FEE_USD || 20);
  check("GET /api/dashboard without a session -> 401", (await call(null, "GET", "/api/dashboard")).status === 401);

  const seededWon = await sql<{ amount: number; n: number }[]>`SELECT coalesce(sum(disputed_amount_usd), 0)::float AS amount, count(*)::int AS n FROM disputes WHERE is_seed AND outcome = 'won'`;
  const seededHold = await sql<{ amount: number; n: number }[]>`SELECT coalesce(sum(amount_usd), 0)::float AS amount, count(*)::int AS n FROM orders WHERE is_seed AND verdict = 'hold'`;
  const seededVerdicts = await sql<{ verdict: string; n: number }[]>`SELECT verdict, count(*)::int AS n FROM orders WHERE is_seed AND verdict IS NOT NULL GROUP BY verdict`;
  const expectVerdict = (v: string) => seededVerdicts.find((x) => x.verdict === v)?.n ?? 0;

  const res = await call(me, "GET", "/api/dashboard");
  const d = await json(res);
  const metric = (k: string) => d[k] as Record<string, number | boolean>;
  check("GET /api/dashboard -> 200 with the spec's keys", res.status === 200 && ["value_under_review", "disputes_won", "chargeback_fees_avoided", "dollars_protected", "dollars_protected_simulated", "recent_activity", "verdict_distribution"].every((k) => k in d));
  check("  ...Value under review = $320 (SEED-F, the only Hold)", metric("value_under_review").amountUsd === 320 && metric("value_under_review").orderCount === 1 && seededHold[0]?.amount === 320);
  check("  ...Disputes won = the seeded wins; Dollars protected = their amounts; no simulated part", metric("disputes_won").count === seededWon[0]?.n && metric("dollars_protected").amountUsd === seededWon[0]?.amount && metric("dollars_protected_simulated").amountUsd === 0, `won=${metric("disputes_won").count} protected=${metric("dollars_protected").amountUsd}`);
  check("  ...Chargeback fees avoided = 2 accepted refunds x the fee", metric("chargeback_fees_avoided").count === 2 && metric("chargeback_fees_avoided").amountUsd === 2 * FEE, `fee=${FEE}`);
  const dist = metric("verdict_distribution");
  check("  ...risk distribution matches the seeded orders by verdict", dist.ship === expectVerdict("ship") && dist.verify === expectVerdict("verify") && dist.hold === expectVerdict("hold") && dist.total === seededVerdicts.reduce((n, v) => n + v.n, 0), JSON.stringify(dist));
  const recent = d.recent_activity as { isDemo: boolean }[];
  check("  ...5 recent activity entries (the seeded rows)", recent.length === 5 && recent.every((r) => r.isDemo));

  const base = { won: Number(metric("disputes_won").count), protectedUsd: Number(metric("dollars_protected").amountUsd), refunds: Number(metric("chargeback_fees_avoided").count) };
  const page = await call(me, "GET", "/");
  const html = await page.text();
  const t = visible(html);
  check("/ (Dashboard) -> 200", page.status === 200);
  check("  ...four metric cards with their labels, $320.00 under review and the caption", ["Value under review", "Disputes won", "Chargeback fees avoided", "Dollars protected"].every((l) => t.includes(l)) && t.includes("$320.00") && t.includes("Figures cover your own activity in this session plus the shared demo history"));
  check("  ...no simulated sub-label yet", !t.includes("from simulated outcomes"));
  check("  ...risk distribution donut (an SVG with a text alternative) and the scoring label", t.includes("Risk distribution") && /<svg[^>]+role="img"[^>]+aria-label="Risk distribution of \d+ scored orders/.test(html) && t.includes("Explainable risk signals + AI reasoning"));
  check("  ...Recent agent activity with 5 rows, and a link to all activity", t.includes("Recent agent activity") && count(html, "<details") === 5 && html.includes('href="/activity"'));
  check("  ...Judge guide with its five steps and a Start demo button", t.includes("Judge guide") && ["See Orders", "Start demo", "SEED-C copy", "Simulate outcome", "Insights"].every((s) => t.includes(s)) && count(html, "<li") >= 5);
  check("  ...'Reset everything for all judges' with the confirm text 'This resets data for all judges', and 'Restart my demo'", t.includes("Reset everything for all judges") && t.includes("Restart my demo") && t.includes("This resets data for all judges") && html.includes("<dialog"));
  check("  ...Demo data badges on the cards", count(t, "Demo data") >= 4, `badges=${count(t, "Demo data")}`);
  check("  ...no 'trained fraud model' wording", !/trained fraud model|AI fraud detection/i.test(t));

  // A session's own actions move the numbers.
  const copies = await startDemo();
  await call(me, "POST", `/api/disputes/${copies[C]}/approve`, { action: "submit_evidence" });
  const wonRes = await call(me, "POST", `/api/disputes/${copies[C]}/simulate-outcome`, { outcome: "won" });
  const copyAmount = Number((await sql`SELECT disputed_amount_usd::float AS a FROM disputes WHERE id = ${copies[C]}`)[0]?.a);
  await call(me, "POST", `/api/disputes/${copies[D]}/approve`, { action: "accept_claim" });
  check("simulate Won on my SEED-C copy and refund my SEED-D copy", wonRes.status === 200 && copyAmount > 0);

  const after = await json(await call(me, "GET", "/api/dashboard"));
  const a = (k: string) => after[k] as Record<string, number>;
  check("  ...Disputes won +1, Dollars protected + the copy's amount, of which all is simulated", a("disputes_won").count === base.won + 1 && a("dollars_protected").amountUsd === base.protectedUsd + copyAmount && a("dollars_protected_simulated").amountUsd === copyAmount, `+${copyAmount}`);
  check("  ...Chargeback fees avoided +1 refund (+ one fee), and fees did NOT enter Dollars protected", a("chargeback_fees_avoided").count === base.refunds + 1 && a("dollars_protected").amountUsd === base.protectedUsd + copyAmount);
  const t2 = visible(await (await call(me, "GET", "/")).text());
  check("  ...the page shows the '$X from simulated outcomes' sub-label", new RegExp(`\\$${copyAmount.toFixed(2).replace(".", "\\.")} from simulated outcomes`).test(t2) || t2.includes("from simulated outcomes"), t2.match(/\$[\d,.]+ from simulated outcomes/)?.[0] ?? "no sub-label");

  const other = await signIn();
  try {
    const theirs = await json(await call(other, "GET", "/api/dashboard"));
    check("another session's dashboard is unaffected by my copies", (theirs.disputes_won as { count: number }).count === base.won && (theirs.dollars_protected_simulated as { amountUsd: number }).amountUsd === 0);
  } finally {
    await cleanup([other.sid]);
  }
};

// ---- M4-05: shared helpers ---------------------------------------------------------------------
const rowsOfSession = async (sql: Sql, sid: string) =>
  (
    await sql<Record<string, number>[]>`
      SELECT
        (SELECT count(*)::int FROM orders WHERE session_id = ${sid}) AS orders,
        (SELECT count(*)::int FROM disputes WHERE session_id = ${sid}) AS disputes,
        (SELECT count(*)::int FROM evidence_artefacts WHERE order_id IN (SELECT id FROM orders WHERE session_id = ${sid})) AS artefacts,
        (SELECT count(*)::int FROM approval_records WHERE dispute_id IN (SELECT id FROM disputes WHERE session_id = ${sid})) AS approvals,
        (SELECT count(*)::int FROM action_executions WHERE dispute_id IN (SELECT id FROM disputes WHERE session_id = ${sid})) AS executions,
        (SELECT count(*)::int FROM dispute_outcomes WHERE dispute_id IN (SELECT id FROM disputes WHERE session_id = ${sid})) AS outcomes,
        (SELECT count(*)::int FROM agent_activity WHERE session_id = ${sid}) AS activity`
  )[0]!;

/** Everything a SESSION restart must leave alone, and the budgets no reset may touch. */
const sharedState = async (sql: Sql) => {
  const seedDisputes = await sql`SELECT id, status, outcome, analysis_computed_at, updated_at FROM disputes WHERE is_seed ORDER BY id`;
  const seedOrders = await sql`SELECT id, status, risk_score, verdict, evidence_completeness, updated_at FROM orders WHERE is_seed ORDER BY id`;
  const seedArtefacts = await sql`SELECT count(*)::int AS n FROM evidence_artefacts WHERE order_id IN (SELECT id FROM orders WHERE is_seed)`;
  const seedActivity = await sql`SELECT id, created_at FROM agent_activity WHERE session_id = 'seed-demo' ORDER BY id`;
  const weights = await sql`SELECT * FROM signal_weights ORDER BY id`; // INCLUDING the counter and updated_at
  const insights = await sql`SELECT * FROM insights_cache ORDER BY id`;
  const daily = await sql`SELECT * FROM llm_daily_usage ORDER BY day`;
  const rate = await sql`SELECT * FROM llm_rate_limits ORDER BY session_id`;
  return JSON.stringify({ seedDisputes, seedOrders, seedArtefacts, seedActivity, weights, insights, daily, rate });
};

/** Give a session something to lose: an order, Start demo copies, approvals, executions, outcomes, activity. */
async function useDemo(who: Who, startDemo: () => Promise<Record<string, string>>) {
  const copies = await startDemo();
  const order = await json(await call(who, "POST", "/api/orders", { itemName: "Live M4 restart check", amountUsd: 120, shippingMethod: "standard", billingCountry: "US", shippingCountry: "US" }));
  const orderId = String(order.orderId ?? "");
  await call(who, "POST", `/api/orders/${orderId}/ship`, { trackingNumber: "9400111899223197428490", carrier: "USPS" }); // 4 evidence items
  await call(who, "POST", "/api/disputes/simulate", { orderId }); // a simulated dispute on the session's own order
  await call(who, "POST", `/api/disputes/${copies[C]}/approve`, { action: "submit_evidence" });
  const won = await call(who, "POST", `/api/disputes/${copies[C]}/simulate-outcome`, { outcome: "won" });
  const refund = await call(who, "POST", `/api/disputes/${copies[D]}/approve`, { action: "accept_claim" });
  return { copies, orderId, ok: won.status === 200 && refund.status === 200 };
}

// ---- M4-05: "Restart my demo" is session-scoped -------------------------------------------------
SECTIONS.restart = async ({ me, sql, startDemo }) => {
  check("POST /api/demo/restart without a session -> 401", (await call(null, "POST", "/api/demo/restart")).status === 401);

  const other = await signIn();
  const startDemoB = async () => {
    const body = await json(await call(other, "POST", "/api/demo/start"));
    const copies = (body.copies ?? []) as { seedDisputeId: string; disputeId: string }[];
    return Object.fromEntries(copies.map((c) => [c.seedDisputeId, c.disputeId]));
  };
  try {
    const a = await useDemo(me, startDemo);
    const b = await useDemo(other, startDemoB);
    check("session A and session B each used the demo (order, copies, approvals, outcomes)", a.ok && b.ok && a.orderId !== "" && b.orderId !== "");

    const a0 = await rowsOfSession(sql, me.sid);
    const b0 = await rowsOfSession(sql, other.sid);
    check("  ...A has 1 order with 4 evidence items, 4 disputes (3 copies + 1 simulated), 2 approvals + executions, 2 outcomes", a0.orders === 1 && a0.disputes === 4 && a0.approvals === 2 && a0.executions === 2 && a0.outcomes === 2 && a0.artefacts === 4 && a0.activity > 0, JSON.stringify(a0));
    const rateA = await sql`SELECT * FROM llm_rate_limits WHERE session_id = ${me.sid}`;
    const shared0 = await sharedState(sql);

    const res = await call(me, "POST", "/api/demo/restart");
    const body = await json(res);
    const deleted = body.deleted as Record<string, number>;
    check("POST /api/demo/restart -> 200 restarted, scope session", res.status === 200 && body.status === "restarted" && body.scope === "session");
    check("  ...it reports what it removed: 1 order, 4 evidence items, 4 disputes, 2 approvals, 2 executions, 2 outcomes", deleted.orders === 1 && deleted.evidenceArtefacts === 4 && deleted.disputes === 4 && deleted.approvals === 2 && deleted.executions === 2 && deleted.outcomes === 2, JSON.stringify(deleted));

    const a1 = await rowsOfSession(sql, me.sid);
    check("  ...A now has nothing but its own reset_demo_session row", a1.orders === 0 && a1.disputes === 0 && a1.artefacts === 0 && a1.approvals === 0 && a1.executions === 0 && a1.outcomes === 0 && a1.activity === 1, JSON.stringify(a1));
    const audit = await sql`SELECT tool_name, step_type, status FROM agent_activity WHERE session_id = ${me.sid}`;
    check("  ...logged as a merchant_action 'reset_demo_session'", audit.length === 1 && audit[0]?.tool_name === "reset_demo_session" && audit[0]?.step_type === "merchant_action");
    check("  ...session B is untouched, row for row", JSON.stringify(await rowsOfSession(sql, other.sid)) === JSON.stringify(b0));
    const shared1 = await sharedState(sql);
    check("  ...the seed, shared weights, proposal AND counter, insights cache, daily usage and rate-limit rows are all byte-identical", shared1 === shared0);
    check("  ...A's own rate-limit row is still there", JSON.stringify(await sql`SELECT * FROM llm_rate_limits WHERE session_id = ${me.sid}`) === JSON.stringify(rateA) && rateA.length === 1);

    const again = await json(await call(me, "POST", "/api/demo/restart"));
    const d2 = again.deleted as Record<string, number>;
    check("restarting again is idempotent: removes nothing but the previous audit row", d2.orders === 0 && d2.disputes === 0 && d2.approvals === 0 && d2.outcomes === 0 && d2.activity === 1 && JSON.stringify(await rowsOfSession(sql, me.sid)) === JSON.stringify(a1));
    check("  ...and still changes nothing shared", (await sharedState(sql)) === shared0);

    // A's pages after a restart.
    const inbox = await (await call(me, "GET", "/disputes")).text();
    check("A's inbox lists the shared examples again, not the old copies", [C, D, E].every((id) => inbox.includes(`/disputes/${id}`)) && !inbox.includes(`/disputes/${a.copies[C]}`));
    check("  ...A's old copy is gone (404)", (await call(me, "GET", `/disputes/${a.copies[C]}`)).status === 404);
    check("  ...B's copy is still there", (await call(other, "GET", `/disputes/${b.copies[C]}`)).status === 200);
    const dashA = await json(await call(me, "GET", "/api/dashboard"));
    const dashB = await json(await call(other, "GET", "/api/dashboard"));
    check("  ...A's dashboard lost its own wins and refunds; B's still has them", (dashA.disputes_won as { count: number }).count === 2 && (dashB.disputes_won as { count: number }).count === 3 && (dashA.dollars_protected_simulated as { amountUsd: number }).amountUsd === 0 && (dashB.dollars_protected_simulated as { amountUsd: number }).amountUsd === 145);

    // The Insights summary is now stale (A's outcomes are gone); it must say so honestly and not claim the AI is unavailable.
    const ins = await json(await call(me, "GET", "/api/insights"));
    const s = ins.summary as { source: string; note: string | null };
    check("Insights after a restart: a rule-based summary of the current data, with the 'refreshed after the next resolved dispute' note", s.source === "rule_based" && (s.note ?? "").includes("refreshed after the next resolved dispute"), s.note ?? "no note");

    // Start demo recreates the three copies, and they work.
    const fresh = await startDemo();
    check("Start demo after the restart creates the three copies again", Object.keys(fresh).length === 3 && fresh[C] === a.copies[C], `${Object.keys(fresh).length} copies`);
    const approve = await json(await call(me, "POST", `/api/disputes/${fresh[C]}/approve`, { action: "submit_evidence" }));
    check("  ...and the fresh SEED-C copy approves as new (not 'already executed')", approve.status === "executed");
    check("  ...B's copies were not disturbed by any of it", JSON.stringify(await rowsOfSession(sql, other.sid)) === JSON.stringify(b0));

    const ui = visible(await (await call(me, "GET", "/")).text());
    check("the Dashboard shows 'Restart my demo' and 'Reset everything for all judges', and the confirm text", ui.includes("Restart my demo") && ui.includes("Reset everything for all judges") && ui.includes("This resets data for all judges") && ui.includes("Clears only your own orders, disputes and activity"));
  } finally {
    await cleanup([other.sid]);
  }
};

// ---- M4-05: the global Reset (owns the database for its duration) --------------------------------
SECTIONS.reset = async ({ me, sql, startDemo }) => {
  check("POST /api/demo/reset without a session -> 401", (await call(null, "POST", "/api/demo/reset")).status === 401);
  await waitForResetCooldown(sql);

  const other = await signIn();
  const startDemoB = async () => {
    const body = await json(await call(other, "POST", "/api/demo/start"));
    const copies = (body.copies ?? []) as { seedDisputeId: string; disputeId: string }[];
    return Object.fromEntries(copies.map((c) => [c.seedDisputeId, c.disputeId]));
  };
  try {
    const a = await useDemo(me, startDemo);
    const b = await useDemo(other, startDemoB);
    // Change the shared state too: approve the seeded weight proposal.
    const proposal = ((await json(await call(me, "GET", "/api/insights"))).proposal as { createdAt: string } | null)?.createdAt ?? "";
    const approved = await call(me, "POST", "/api/insights/approve-weights", { proposalCreatedAt: proposal });
    const w0 = await activeWeights(sql);
    check("setup: two sessions used the demo, an approved weight change (first-time high value 23), outcomes counted", a.ok && b.ok && approved.status === 200 && w0?.ft === 23 && Number(w0?.n) === 0);
    await sql`UPDATE signal_weights SET resolved_since_last_proposal = 3 WHERE is_active`; // a non-zero counter to prove it is reset

    const daily0 = JSON.stringify(await sql`SELECT * FROM llm_daily_usage ORDER BY day`);
    const rate0 = JSON.stringify(await sql`SELECT * FROM llm_rate_limits ORDER BY session_id`);
    const usage0 = await dailyCalls(sql);

    // ---- atomic: a failure after the wipe, and after the seed, rolls EVERYTHING back (the real store, the real database)
    const { createDrizzleResetStore } = await import("../../src/lib/demo/store");
    const store = createDrizzleResetStore(getDb());
    const before = JSON.stringify({ a: await rowsOfSession(sql, me.sid), b: await rowsOfSession(sql, other.sid), shared: await sharedState(sql) });
    for (const stage of ["after the wipe", "after the seed"] as const) {
      let failed = false;
      try {
        await store.transaction(async (tx) => {
          await tx.lock();
          await tx.wipe();
          if (stage === "after the seed") await tx.seed(new Date());
          throw new Error("injected failure");
        });
      } catch (err) {
        failed = err instanceof Error && err.message === "injected failure";
      }
      const after = JSON.stringify({ a: await rowsOfSession(sql, me.sid), b: await rowsOfSession(sql, other.sid), shared: await sharedState(sql) });
      check(`rollback: a failure ${stage} leaves both sessions' data, the seed, weights and counter exactly as they were`, failed && after === before);
    }

    // ---- the reset itself
    const res = await call(me, "POST", "/api/demo/reset");
    const body = await json(res);
    const del = body.deleted as Record<string, number>;
    check("POST /api/demo/reset -> 200 reset, scope all", res.status === 200 && body.status === "reset" && body.scope === "all");
    check("  ...it reports visitor data removed from both sessions (2+ orders, 8+ disputes, 8+ evidence items, 4+ approvals, 4+ outcomes)", del.orders >= 2 && del.disputes >= 8 && del.evidenceArtefacts >= 8 && del.approvals >= 4 && del.executions >= 4 && del.outcomes >= 4, JSON.stringify(del));

    const [tot] = await sql<Record<string, number>[]>`
      SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM orders WHERE NOT is_seed) AS orders_visitor,
             (SELECT count(*)::int FROM evidence_artefacts) AS artefacts, (SELECT count(*)::int FROM disputes) AS disputes,
             (SELECT count(*)::int FROM disputes WHERE NOT is_seed) AS disputes_visitor, (SELECT count(*)::int FROM approval_records) AS approvals,
             (SELECT count(*)::int FROM action_executions) AS executions, (SELECT count(*)::int FROM dispute_outcomes) AS outcomes,
             (SELECT count(*)::int FROM agent_activity WHERE session_id = 'seed-demo') AS seed_activity,
             (SELECT count(*)::int FROM agent_activity WHERE session_id IS DISTINCT FROM 'seed-demo') AS other_activity`;
    check("  ...the database is exactly the seed: 10 orders, 40 evidence items, 8 disputes, 0 approvals, 0 executions, 5 outcomes, 8 seeded activity rows", tot?.orders === 10 && tot?.orders_visitor === 0 && tot?.artefacts === 40 && tot?.disputes === 8 && tot?.disputes_visitor === 0 && tot?.approvals === 0 && tot?.executions === 0 && tot?.outcomes === 5 && tot?.seed_activity === 8, JSON.stringify(tot));
    const audit = await sql<{ session_id: string; tool_name: string; step_type: string }[]>`SELECT session_id, tool_name, step_type FROM agent_activity WHERE session_id IS DISTINCT FROM 'seed-demo'`;
    check("  ...the only other activity row is the reset's own: merchant_action 'reset_demo_global' by the caller", audit.length === 1 && audit[0]?.tool_name === "reset_demo_global" && audit[0]?.step_type === "merchant_action" && audit[0]?.session_id === me.sid, JSON.stringify(audit));
    const w1 = await activeWeights(sql);
    check("  ...weights back to the defaults, the seeded proposal pending again (first-time high value -> 23), counter 0", w1?.ft === 20 && w1?.cm === 20 && w1?.rs === 15 && w1?.hr === 20 && w1?.de === 15 && w1?.ra === 10 && w1?.pft === 23 && w1?.at !== null && w1?.n === 0, JSON.stringify(w1));
    check("  ...the global daily usage counter and every per-session rate-limit row are unchanged (no model call either)", JSON.stringify(await sql`SELECT * FROM llm_daily_usage ORDER BY day`) === daily0 && JSON.stringify(await sql`SELECT * FROM llm_rate_limits ORDER BY session_id`) === rate0 && (await dailyCalls(sql)) === usage0);

    const ins = await json(await call(me, "GET", "/api/insights"));
    const summary = ins.summary as { source: string; usedFallback: boolean; note: string | null };
    const outcomes = ins.outcomes as { total: number; won: number; lost: number; refunded: number };
    check("  ...Insights is populated from the cache straight away: seeded summary, no note; H1-H5 in the breakdown", summary.source === "cached" && !summary.usedFallback && summary.note === null && outcomes.total === 5 && outcomes.won === 2 && outcomes.lost === 1 && outcomes.refunded === 2);
    const dash = await json(await call(me, "GET", "/api/dashboard"));
    check("  ...the Dashboard is back to the seeded figures ($320 under review, nothing simulated)", (dash.value_under_review as { amountUsd: number }).amountUsd === 320 && (dash.dollars_protected_simulated as { amountUsd: number }).amountUsd === 0);
    check("  ...both sessions' old copies are gone (404), the seeded examples are open again", (await call(me, "GET", `/disputes/${a.copies[C]}`)).status === 404 && (await call(other, "GET", `/disputes/${b.copies[C]}`)).status === 404 && (await call(me, "GET", `/disputes/${C}`)).status === 200);
    check("  ...and the sessions are still signed in", (await call(other, "GET", "/api/dashboard")).status === 200);

    // ---- Start demo works again in the same session
    const fresh = await startDemo();
    check("Start demo in the same session creates the three copies again after a reset", Object.keys(fresh).length === 3);

    // ---- the cooldown (timed from a second reset, so the checks above cannot eat the 10 s)
    console.log("INFO  waiting for the 10 s cooldown to pass, then resetting again to test it...");
    await waitForResetCooldown(sql);
    const reset2 = await call(other, "POST", "/api/demo/reset");
    check("after the cooldown a reset is accepted again (here by the other session) and it clears the copies", reset2.status === 200 && (await rowsOfSession(sql, me.sid)).disputes === 0);
    await startDemo(); // 3 new copies for A, a second or so after the reset
    const refused = await call(me, "POST", "/api/demo/reset");
    const rb = await json(refused);
    check("a reset right after another -> 429 cooldown, with Retry-After and the seconds left", refused.status === 429 && rb.error === "cooldown" && Number(refused.headers.get("retry-after")) >= 1 && Number(refused.headers.get("retry-after")) <= 10 && Number(rb.retryAfterSeconds) >= 1, `retry-after=${refused.headers.get("retry-after")}`);
    check("  ...the refused reset deleted nothing: the new copies are still there", (await rowsOfSession(sql, me.sid)).disputes === 3);
    check("  ...the cooldown is global: the other session is refused too", (await call(other, "POST", "/api/demo/reset")).status === 429);
    check("  ...a session restart is not subject to the cooldown", (await call(me, "POST", "/api/demo/restart")).status === 200 && (await rowsOfSession(sql, me.sid)).disputes === 0);
    const gone = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agent_activity WHERE tool_name = 'reset_demo_global'`;
    check("  ...there is exactly one reset_demo_global row (older ones are cleared with the rest)", gone[0]?.n === 1);
  } finally {
    await cleanup([other.sid]);
  }
};

// ---- M4-05: db:seed:verify tolerates the audit rows a reset leaves behind ---------------------------
SECTIONS.verify = async ({ me, sql }) => {
  const { spawnSync } = await import("node:child_process");
  await waitForResetCooldown(sql);
  const reset = await call(me, "POST", "/api/demo/reset");
  const restart = await call(me, "POST", "/api/demo/restart");
  check("a global reset and a session restart both succeeded (two audit rows now exist)", reset.status === 200 && restart.status === 200);
  const run = spawnSync("cmd", ["/c", "npm run db:seed:verify"], { encoding: "utf8", cwd: process.cwd() });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  check("db:seed:verify passes with them present", run.status === 0 && out.includes("ALL CHECKS PASSED"));
  check("  ...and lists them as tolerated: reset_demo* = 2", /reset_demo\*=2/.test(out), (/non-seed activity rows[^\n]*/.exec(out)?.[0] ?? "").trim());
};

async function main(): Promise<void> {
  guardLocalOnly();
  const names = Object.keys(SECTIONS);
  if (WANT !== "all" && !names.includes(WANT)) {
    console.log(`Unknown section "${WANT}". Sections: ${names.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  try {
    for (const [name, fn] of Object.entries(SECTIONS)) {
      if (WANT !== "all" && WANT !== name) continue;
      console.log(`\n== ${name} ==`);
      const me = await signIn(); // a distinct session per section
      const sql = getSql();
      try {
        await fn({
          me,
          sql,
          startDemo: async () => {
            const body = await json(await call(me, "POST", "/api/demo/start"));
            const copies = (body.copies ?? []) as { seedDisputeId: string; disputeId: string }[];
            return Object.fromEntries(copies.map((c) => [c.seedDisputeId, c.disputeId]));
          },
        });
      } catch (err) {
        noteFailure(`unexpected error in ${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
      } finally {
        await cleanup([me.sid]);
      }
    }
  } finally {
    await closeDb();
  }
}

void main().then(finish);