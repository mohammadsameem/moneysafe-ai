# Deploying MoneySafe AI to Vercel + Supabase

This is the minimal deploy (task M1-12). It uses the Supabase project you already migrated and seeded. No secrets belong in this file.

## 0. Before you start

- The repo is on GitHub (Vercel imports from a Git host). Push `master`, or create a branch and import that.
- `npm run build`, `npm run typecheck` and `npm test` pass locally.
- Your Supabase database is migrated and seeded. If it is not: `npm run db:migrate` then `npm run db:seed` (both read `.env.local`; they use `DIRECT_URL`). `npm run db:seed:verify` should print `ALL CHECKS PASSED`.

## 1. Get the two database connection strings (Supabase)

Supabase dashboard, your project, **Connect** (top bar). Use the pooler strings, **not** "Direct connection": that host (`db.<ref>.supabase.co`) is IPv6-only and fails on many networks and on Vercel.

| Variable | Which string | Port |
|---|---|---|
| `DATABASE_URL` | **Transaction pooler** | 6543 |
| `DIRECT_URL` | **Session pooler** | 5432 |

Replace `[YOUR-PASSWORD]` with your database password. If it contains special characters (`@ : / ? # %`), URL-encode them.

`DATABASE_URL` is what the deployed app uses. `DIRECT_URL` is used only by `drizzle-kit` migrations from your machine, so Vercel does not strictly need it, but add it anyway so the two environments match.

## 2. Create the Vercel project

1. vercel.com, **Add New... > Project**, import the GitHub repo.
2. Framework preset: **Next.js** (detected). Leave the build command, output directory and install command at their defaults.
3. **Region:** Project Settings > Functions > Function Region. Pick the region closest to your Supabase region (shown on the Supabase project's Connect page) to keep database calls fast.
4. Before pressing Deploy, open **Environment Variables** and add the variables below.

## 3. Environment variables

Add each to **Production** (and **Preview** if you want preview deployments to work). Names only here; take the values from your `.env.local`.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Transaction pooler string, port 6543 |
| `DIRECT_URL` | recommended | Session pooler string, port 5432 |
| `NEXTAUTH_SECRET` | yes | 16+ random characters. New one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `NEXTAUTH_URL` | yes | The deployed URL, e.g. `https://<project>.vercel.app` (no trailing slash needed). PayPal's return and cancel links are built from it, and it decides whether the session cookie is `Secure` |
| `DEMO_PASSWORD` | yes | Shown on the login page by design. Do not reuse a real password |
| `PAYPAL_CLIENT_ID` | for live PayPal | Sandbox app credentials. Without both PayPal values the app runs on seeded data |
| `PAYPAL_CLIENT_SECRET` | for live PayPal | Same |
| `DEMO_MODE` | no | `false` for the real sandbox flow; `true` simulates every PayPal write |
| `CHARGEBACK_FEE_USD` | no | Default 20 |
| `CONTEST_EFFORT_USD` | no | Default 10 |
| `LLM_API_KEY` | no | Primary provider key. Empty means no model is ever called and every AI feature uses its rule-based result |
| `LLM_BASE_URL`, `LLM_MODEL` | no | Recommended: Groq, `https://api.groq.com/openai/v1` and `openai/gpt-oss-120b` (the code defaults are Gemini's, so set these) |
| `LLM_FALLBACK_API_KEY` | no | Second provider, tried once if the first fails. Ignored if `LLM_API_KEY` is empty |
| `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_MODEL` | no | Recommended: Gemini, `https://generativelanguage.googleapis.com/v1beta/openai/` and `gemini-3.8-flash` (the code defaults are Groq's, so set these) |
| `LLM_DAILY_CAP` | no | Calls per UTC day across everyone. Default 200 |

### The `NEXTAUTH_URL` chicken-and-egg

You only know the URL after the first deploy. Either:

- set `NEXTAUTH_URL` to the URL Vercel will give you (`https://<project-name>.vercel.app`, from the project name you chose), or
- deploy once with a placeholder, copy the real URL, set `NEXTAUTH_URL`, then **Deployments > ... > Redeploy** (environment variable changes apply only to new deployments).

If you later add a custom domain, update `NEXTAUTH_URL` and redeploy.

## 4. Deploy

Press **Deploy**. When it finishes, open the deployment URL.

## 5. Keep-alive cron

`vercel.json` in this repo defines one cron: `GET /api/demo/status` at `0 12 */3 * *` (12:00 UTC, every third day). That endpoint runs `SELECT 1`, which keeps the Supabase free project from pausing after inactivity.

After the first production deploy, check **Project > Settings > Cron Jobs**: the job should be listed. You can press **Run** there to test it. Cron jobs only run on **production** deployments.

## 6. Verify

1. `https://<your-url>/api/demo/status` returns `{"demoMode":false,"db":"ok"}` with HTTP 200. If it says `"db":"error"` (HTTP 503), recheck `DATABASE_URL` (port 6543, password encoded). The response never contains the reason, so look at **Logs** in Vercel.
2. `https://<your-url>/login` shows the **Demo login** box. Sign in with it.
3. `/orders` lists the 10 seeded orders, each with a "Demo data" badge, including SEED-A (Ship, 0), SEED-B (Verify first, 55) and SEED-F (Hold, 70).
4. Open SEED-B: it shows the signal breakdown, an explanation and a draft message.
5. PayPal (needs PayPal values and `DEMO_MODE=false`): on `/orders`, open **New sandbox order**, submit, approve as a sandbox buyer on PayPal, and you should return to the order scored. Use a sandbox buyer account from developer.paypal.com > Testing Tools > Sandbox Accounts.

## 7. Record the URL

Put the public URL in the README (task M5-01) and in the Devpost write-up (task M4-08).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Sign-in loops back to `/login` | `NEXTAUTH_URL` does not match the URL you are using, or `NEXTAUTH_SECRET` is missing. Fix and redeploy |
| `/api/demo/status` is 503 | `DATABASE_URL` wrong, password not URL-encoded, or you used the direct (IPv6) host |
| Returning from PayPal shows the login page | The session cookie was not sent: you started the order on a different host than `NEXTAUTH_URL` |
| AI text always says "AI unavailable" | No `LLM_API_KEY`, the daily cap or the hourly per-session limit (10 calls) was reached, or the provider is down. The app still works with rule-based text |
| Build fails on Vercel but passes locally | Compare Node versions (Project Settings > General > Node.js Version) and look at the first error in the build log |
| Function times out | The order return route allows up to 60 s (`maxDuration`). If your Vercel plan caps it lower, lower `maxDuration` in `src/app/api/orders/route.ts` and `paypal-return/route.ts` |

## 8. Steps only the owner can do (M4-08 and M4-08b)

Everything below needs your Vercel and Supabase accounts. All three scripts print pass/fail lines and never print a secret. Run them from your machine with `.env.local` in place.

**A. Database (once, before or right after the first deploy)**

1. `npm run db:migrate` then `npm run db:check`. The schema has not changed since the first migration, so this is a no-op if you already migrated.
2. `npm run db:seed` if the database is empty, then `npm run db:seed:verify` must print `ALL CHECKS PASSED`.

**B. Deploy**

3. Set the variables from section 3 in Vercel (Production, and Preview if you want it). `NEXTAUTH_URL` must be the exact URL you will open.
4. Deploy, then open `https://<your-url>/api/demo/status`: it should print `{"demoMode":...,"db":"ok"}`.

**C. Smoke test the production URL (read-only, safe on the real site)**

```powershell
$env:QA_BASE = "https://<your-url>"
npm run qa:smoke
```

It must end with `ALL CHECKS PASSED` (22 checks). It writes nothing. If `DATABASE_URL` is in `.env.local` it also proves that reading the seeded pages spent no model call.

**D. Verify the budget guard on a preview deployment (M4-08b)**

The daily counter is global and shared by every deployment on the same database, so do this when nobody is using the demo.

1. `npm run qa:budget -- --print-cap` prints a number: today's usage plus 3.
2. In Vercel, add `LLM_DAILY_CAP=<that number>` and `DEMO_MODE=true` to a **Preview** deployment only, and redeploy that preview. (Not to Production.)
3. Run:

```powershell
$env:QA_BASE = "https://<preview-url>"
$env:QA_ALLOW_REMOTE = "1"
$env:QA_EXPECT_CAP = "<that number>"
npm run qa:budget
```

   It spends the remaining 3 calls, then creates 4 more demo orders and checks that each is created (not a 429), keeps its rule-based score, shows "AI unavailable", has an `llm_budget_exceeded` row, and that the seeded disputes and Insights still load. It deletes its own orders and re-seeds the shared demo state, so it also resets any judge activity.
4. Delete the preview's `LLM_DAILY_CAP` and `DEMO_MODE` variables (Production keeps `LLM_DAILY_CAP=200`). The counter itself starts again at 00:00 UTC.

**E. Cron**

5. Vercel > Project > Settings > Cron Jobs: the `/api/demo/status` job is listed. Press **Run**; the log should show a 200. (Cron jobs run only on production deployments.)

**F. By hand on production**

6. Sign in, press **Start demo**, open the SEED-C copy, **Approve** it: the "Simulated" badge appears. The "Demo data" badges show on the seeded rows.
7. Retry flow: with `DEMO_MODE=false`, approve a real (non-seed) dispute; a failure should show an error with a **Retry** button, and the retry reuses the same `PayPal-Request-Id`. `qa:live` and the unit tests cover this locally. The sandbox cannot hand this app a dispute, so it can only be seen by forcing a PayPal error.
