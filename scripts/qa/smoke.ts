/**
 * Read-only smoke test for a running deployment (local, preview or production).
 *
 *   QA_BASE=https://<your-app>.vercel.app npm run qa:smoke
 *
 * It WRITES NOTHING: it signs in (a JWT, no database row), loads pages and reads API responses. That is why,
 * unlike qa:live and qa:browser, it is allowed to run against a remote URL without QA_ALLOW_REMOTE.
 * Credentials come from DEMO_PASSWORD in the environment and are never printed.
 *
 * What it checks (M4-08 / M4-08b):
 *   - /api/demo/status answers 200 with db "ok" (the keep-alive cron target);
 *   - EVERY /api route (found by scanning src/app/api) answers 401 without a session, except the status check
 *     and NextAuth's own endpoints; PayPal's two browser-redirect routes may instead redirect to /login;
 *   - signed in, the seeded data is there and badged: the orders and their scores, the dispute inbox, the three
 *     seeded dispute verdicts, the Dashboard figures, the Insights page and the Agent Activity page;
 *   - when DATABASE_URL is available: loading all of that spent no model call (llm_daily_usage did not move).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { seedId } from "../../src/seed/ids";
import { BASE, call, check, closeDb, count, finish, getSql, info, json, signIn, visible, type Who } from "./common";

const API_DIR = join(process.cwd(), "src", "app", "api");
const DUMMY_ID = "00000000-0000-4000-8000-000000000000";

/** Every route.ts under src/app/api, as the URL path it serves. */
function apiRoutes(dir = API_DIR, prefix = "/api"): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "__tests__") continue;
    if (statSync(full).isDirectory()) {
      if (name.startsWith("[...")) continue; // NextAuth's catch-all
      found.push(...apiRoutes(full, `${prefix}/${name.startsWith("[") ? DUMMY_ID : name}`));
    } else if (name === "route.ts") {
      found.push(prefix);
    }
  }
  return found;
}

const dailyCalls = async (): Promise<number | null> => {
  if (!process.env.DATABASE_URL) return null;
  try {
    const day = new Date().toISOString().slice(0, 10);
    return (await getSql()<{ n: number }[]>`SELECT call_count AS n FROM llm_daily_usage WHERE day = ${day}`)[0]?.n ?? 0;
  } catch {
    return null;
  }
};

async function main(): Promise<void> {
  console.log(`Smoke target: ${BASE}  (read-only)`);
  const usageBefore = await dailyCalls();

  // ---- 1. health / keep-alive -----------------------------------------------------------------------
  const status = await call(null, "GET", "/api/demo/status");
  const statusBody = await json(status);
  check("GET /api/demo/status -> 200 with db 'ok' (what the cron hits)", status.status === 200 && statusBody.db === "ok", `${status.status} ${JSON.stringify(statusBody)}`);
  check("  ...it needs no session and leaks nothing but demoMode and db", Object.keys(statusBody).sort().join(",") === "db,demoMode");

  // ---- 2. every other API route is closed without a session ---------------------------------------------
  const routes = apiRoutes().filter((r) => r !== "/api/demo/status");
  const open: string[] = [];
  for (const route of routes) {
    for (const method of ["GET", "POST"]) {
      const res = await call(null, method, route, method === "POST" ? {} : undefined);
      const redirectsToLogin = res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/login");
      const browserRedirect = /\/api\/orders\/paypal-(return|cancel)$/.test(route);
      if (res.status !== 401 && !(browserRedirect && redirectsToLogin)) open.push(`${method} ${route.replace(DUMMY_ID, "{id}")} -> ${res.status}`);
    }
  }
  check(`all ${routes.length} other /api routes (GET and POST, ${routes.length * 2} calls) answer 401 without a session`, open.length === 0, open.slice(0, 4).join(" | "));

  const page = await call(null, "GET", "/orders");
  check("a page without a session redirects to /login", page.status >= 300 && page.status < 400 && (page.headers.get("location") ?? "").includes("/login"), `${page.status} ${page.headers.get("location") ?? ""}`);

  // ---- 3. signed in -------------------------------------------------------------------------------------------
  if (!process.env.DEMO_PASSWORD) {
    check("DEMO_PASSWORD is set, so the demo login can be used", false);
    return;
  }
  const me: Who = await signIn();
  check("the demo login works and gives a session id", me.sid.length > 10);
  if (me.sid.length <= 10) return;

  const html = async (path: string) => {
    const res = await call(me, "GET", path);
    return { status: res.status, text: visible(await res.text()) };
  };

  // Orders (REQ-RISK-*, REQ-DEMO-07)
  const orders = (await json(await call(me, "GET", "/api/orders"))) as { orders?: Array<{ id: string; riskScore: number | null; verdict: string; isDemo: boolean }> };
  const list = orders.orders ?? [];
  const by = (key: string) => list.find((o) => o.id === seedId("order", key));
  check("/api/orders lists the 10 seeded orders, all flagged as demo data", list.filter((o) => o.isDemo).length >= 10 && list.length >= 10, `${list.length} orders`);
  check("  ...SEED-A is Ship / 0, SEED-B is Verify / 55, SEED-F is Hold / 70", by("SEED-A")?.verdict === "ship" && by("SEED-A")?.riskScore === 0 && by("SEED-B")?.verdict === "verify" && by("SEED-B")?.riskScore === 55 && by("SEED-F")?.verdict === "hold" && by("SEED-F")?.riskScore === 70, `A=${by("SEED-A")?.verdict}/${by("SEED-A")?.riskScore} B=${by("SEED-B")?.verdict}/${by("SEED-B")?.riskScore} F=${by("SEED-F")?.verdict}/${by("SEED-F")?.riskScore}`);

  const ordersPage = await html("/orders");
  check("/orders renders with 'Demo data' badges", ordersPage.status === 200 && count(ordersPage.text, "Demo data") >= 10, `${count(ordersPage.text, "Demo data")} badges`);

  const orderB = await html(`/orders/${seedId("order", "SEED-B")}`);
  check("SEED-B opens: signals, explanation and the verification draft are there", orderB.status === 200 && /country/i.test(orderB.text) && /first.time/i.test(orderB.text) && /rush/i.test(orderB.text) && /Verify/i.test(orderB.text));
  const orderF = await html(`/orders/${seedId("order", "SEED-F")}`);
  check("SEED-F opens: Hold, with the value-above-threshold signal", orderF.status === 200 && /Hold/.test(orderF.text) && /\$255/.test(orderF.text), /\$255/.test(orderF.text) ? "" : "no $255 threshold text");

  // Disputes (REQ-DIS-*)
  const inbox = await html("/disputes");
  check("/disputes (Open) lists the three shared examples", inbox.status === 200 && count(inbox.text, "Shared example") >= 3, `${count(inbox.text, "Shared example")} badges`);
  for (const [key, pct, label, rec] of [["SEED-C", "95", "Strong", "Contest"], ["SEED-D", "27", "Weak", "Refund"], ["SEED-E", "44", "Moderate", "Contest"]] as const) {
    const d = await html(`/disputes/${seedId("dispute", key)}`);
    check(`${key} opens with win likelihood ${pct}% / ${label} / ${rec} (read-only: it is a shared example)`, d.status === 200 && new RegExp(`${pct}\\s?%`).test(d.text) && d.text.includes(label) && d.text.includes(rec), `${d.status}`);
  }

  // Dashboard, Insights, Activity
  const dash = await html("/");
  check("Dashboard renders and shows Value under review $320.00 for a fresh session", dash.status === 200 && dash.text.includes("$320.00"));
  const dashApi = await json(await call(me, "GET", "/api/dashboard"));
  check("  ...GET /api/dashboard has all seven keys", ["value_under_review", "disputes_won", "chargeback_fees_avoided", "dollars_protected", "dollars_protected_simulated", "recent_activity", "verdict_distribution"].every((k) => k in dashApi));
  const insights = await html("/insights");
  check("Insights renders (from stored data, with no model call)", insights.status === 200 && /Insights/.test(insights.text));
  info(`Insights shows a pending weight proposal: ${insights.text.includes("Proposed weight change") ? "yes" : "no (it may have been decided; weights are shared)"}`);
  const insightsApi = await call(me, "GET", "/api/insights");
  check("  ...GET /api/insights -> 200", insightsApi.status === 200, `${insightsApi.status}`);
  const activity = await html("/activity");
  check("Agent Activity renders", activity.status === 200 && /Agent Activity/.test(activity.text));
  const act = await call(me, "GET", "/api/activity?page=1&pageSize=5");
  check("  ...GET /api/activity -> 200 with entries", act.status === 200 && Array.isArray(((await json(act)) as { entries?: unknown[] }).entries));
  const missing = await call(me, "GET", `/disputes/${DUMMY_ID}`);
  check("a record that does not exist is a real 404", missing.status === 404, `${missing.status}`);

  // ---- 4. no model call was spent by reading ----------------------------------------------------------------
  const usageAfter = await dailyCalls();
  if (usageBefore === null || usageAfter === null) info("DATABASE_URL is not set here, so 'no model call while reading' was not checked");
  else check(`reading all of the above spent no model call (llm_daily_usage ${usageBefore} -> ${usageAfter})`, usageAfter === usageBefore);
}

main()
  .catch((err: unknown) => check(`unexpected error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, false))
  .finally(async () => {
    await closeDb().catch(() => undefined);
    finish();
  });
