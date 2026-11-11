# MoneySafe AI

**The risk desk for micro-merchants.**

MoneySafe AI scores each PayPal order for chargeback risk with explainable rule-based signals, and helps a small seller decide whether to contest or refund a dispute. An LLM writes the plain-language explanation and the draft messages; it never sets a score and never sends anything. Every action that would reach PayPal waits for the merchant's explicit approval.

- **Live demo:** `https://<your-app>.vercel.app` _(placeholder: add the production URL after the Vercel deploy, see [DEPLOY.md](DEPLOY.md))_
- **Devpost:** `<link to the Devpost submission>` _(placeholder)_
- **Demo video:** `<link to the walkthrough video>` _(placeholder)_

## Try it

Open the live demo and sign in with the public demo account. The login page shows the same credentials in a "Demo login" box.

| | |
|---|---|
| Email | `demo@moneysafe.ai` |
| Password | shown on the login page _(it is `DEMO_PASSWORD` in the deployment's environment; the account is public by design, so never reuse a real password)_ |

A 60-second path: sign in, **Dashboard → Start demo** (gives you your own copies of three example disputes) → open the 95% "Strong" dispute → **Approve** → **Simulate outcome: Won** → watch **Dollars protected** and **Insights** move. **Restart my demo** undoes only your own changes; **Reset everything for all judges** resets the shared database.

## What is live and what is simulated

This is a hackathon demo on PayPal's **sandbox**. Please read this before judging what you see.

| | Live (really happens) | Simulated or mocked |
|---|---|---|
| **Orders** | Creating a sandbox order, sending the buyer to PayPal to approve, and capturing the payment, all against the PayPal sandbox API (needs sandbox credentials and `DEMO_MODE=false`). Without credentials, or in Demo Mode, the app creates a scored demo order locally and labels it. | The 10 seeded example orders are fixed demo data, marked "Demo data". |
| **Risk scoring** | Always real: the rule engine (six signals, weighted points) runs on every order. One implementation, in `src/lib/scoring`. | |
| **AI text** | The explanation, verification draft, dispute analysis adjustment, draft response and Insights summary come from a real model (Groq). If the model is unavailable, over budget or invalid, the app shows the rule-based result and says "AI unavailable". | The model is told it may not set the score; its win-probability adjustment is clamped to ±0.1. |
| **Shipping and tracking** | The tracking number you enter is sent to PayPal's add-tracking API for a real sandbox order. | The carrier **scan events** ("In Transit", "Delivered") are mocked: no carrier tracking provider is integrated. |
| **Disputes** | **Real disputes work.** A sandbox buyer can open a dispute in the Resolution Center. **Check PayPal for disputes** (live mode only) reads it through the Disputes API and links it to a real, captured order in the signed-in session only; no other visitor can see or act on it. The page shows PayPal's own status, stage and due date, and the usual analysis (evidence completeness, win probability, the contest-or-refund expected-value rule) runs on it. **If PayPal reports the dispute as closed** (for example `RESOLVED_BUYER_FAVOUR`, a refund made outside the app), the next page view or sync marks it resolved, stores PayPal's outcome, shows "Resolved on PayPal" and hides Approve and Reject. That creates no approval, no execution and no learning-loop outcome. We saw this on our real $230 dispute. | **The 8 seeded disputes and the copies Start demo gives you are example data, not PayPal disputes.** |
| **Dispute actions** | On a real dispute the app offers only what PayPal's `allowed_response_options` allows at that moment. At the inquiry stage PayPal allows a refund or an offer, not evidence, so the app offers the refund (accept claim) and no evidence button (PayPal's make-offer response is not implemented). Approval goes through the same approval gate to the live PayPal call with a stored `PayPal-Request-Id`, and a real dispute is never simulated. When a live write fails, the PayPal error (issue codes, field names, `debug_id`; never a secret or a field value) is stored in the activity row and shown on the page with Retry. **Verified against the sandbox:** reading and matching a real dispute, its real status and allowed actions, a live write that PayPal rejected (HTTP 422, because the dispute had already been settled), and PayPal's closure of that dispute being picked up. **Not yet run:** a successful live refund or evidence submission on a real dispute. PayPal's accept-claim reference lists only `note` as required; we send `note` and `accept_claim_type: REFUND`, which has not yet succeeded live. Draft responses say "The evidence on file includes ..." because the app sends text only, never files. | **Approving a seeded or Start-demo dispute simulates the PayPal call**, and a "Simulated" badge appears. |
| **Outcomes** | | **Won / Lost outcomes are simulated** with the "Simulate outcome" control (or recorded automatically when you accept a refund). They are labelled "simulated" everywhere, and Dollars protected shows the simulated part separately. |
| **Learning loop** | Weight proposals are computed from the recorded outcomes and need your approval. | The history it learns from is the seeded demo history plus simulated outcomes. |

Other things worth knowing:

- A real PayPal dispute belongs to the session that owns the matched order. Another visitor's inbox, dispute page and approve call never see it (they answer 404).
- The demo shares one database. Signal weights and the pending weight proposal are shared by everyone; **Reset everything for all judges** resets them (with a 10-second cooldown).
- The AI budget is limited (see `LLM_DAILY_CAP` below). When it is used up, everything still works with rule-based text.
- The risk score is a sum of explainable signals. It is **not** a trained fraud model, and is never described as one.

## Screenshots

_Placeholders: capture these from the production site and save them under `public/screenshots/` (WebP, 300 KB or less each)._

| | |
|---|---|
| Dashboard | `![Dashboard](public/screenshots/dashboard.webp)` |
| Orders list | `![Orders](public/screenshots/orders.webp)` |
| Order detail (SEED-B, with signals) | `![Order detail](public/screenshots/order-seed-b.webp)` |
| Dispute detail (SEED-C, contest, win likelihood) | `![Dispute SEED-C](public/screenshots/dispute-seed-c.webp)` |
| Dispute detail (SEED-E, evidence gaps) | `![Dispute SEED-E](public/screenshots/dispute-seed-e.webp)` |
| Insights (pending proposal) | `![Insights](public/screenshots/insights.webp)` |
| Agent Activity | `![Agent Activity](public/screenshots/activity.webp)` |

(`npm run qa:browser` writes full-page screenshots of every page at 375, 768 and 1280 px to `.qa/screens/` on your machine, which is a quick source for these.)

## Run it locally

You need Node 18.17 or newer (Next.js 14's minimum; it has only been run here on Node 26), a Postgres database (a free Supabase project works) and, optionally, PayPal sandbox and LLM keys. Without the optional keys everything runs on seeded data and rule-based text.

```powershell
Copy-Item .env.example .env.local   # then fill in DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, DEMO_PASSWORD
npm install; npm run db:migrate; npm run db:seed; npm run dev
```

The second line is the one-command setup once `.env.local` is filled in. On macOS or Linux use `cp` instead of `Copy-Item` and `&&` instead of `;`. Open http://localhost:3000.

For the seeded demo without PayPal, set `DEMO_MODE=true`. To deploy, follow [DEPLOY.md](DEPLOY.md).

### Environment variables

Names only; copy `.env.example` for the full commented template. Never commit `.env.local`.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection for the app. With Supabase, the **transaction pooler** string (port 6543). |
| `DIRECT_URL` | for migrations | | Postgres connection for `drizzle-kit` (Supabase **session pooler**, port 5432). |
| `NEXTAUTH_SECRET` | yes | | Signs the session cookie. 16+ random characters. |
| `NEXTAUTH_URL` | yes | `http://localhost:3000` | The app's public URL. PayPal return links and the secure-cookie decision are built from it. |
| `DEMO_PASSWORD` | yes | | The public demo login password (shown on the login page). |
| `DEMO_MODE` | no | `false` | `true` simulates every PayPal write and creates scored demo orders without PayPal. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | for live PayPal | | Sandbox app credentials. Without both, the app runs on seeded and demo data. |
| `LLM_API_KEY` | no | empty | Primary model provider key. **Empty means no model is ever called**; every AI feature shows its rule-based result. |
| `LLM_BASE_URL`, `LLM_MODEL` | no | see note | Any OpenAI-compatible endpoint and model. We run and test Groq (`https://api.groq.com/openai/v1`, `openai/gpt-oss-120b`, as in `.env.example`). Set both: the built-in defaults are a different provider that we have not verified. |
| `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_MODEL` | no | **off** | Optional second provider, tried once if the first fails. Off unless `LLM_FALLBACK_API_KEY` is set, and ignored if `LLM_API_KEY` is empty. The code path is tested with mocked HTTP only; we have not run it against a live second provider, so we do not claim one. |
| `LLM_DAILY_CAP` | no | `200` | Model calls per UTC day across all visitors. |
| `CHARGEBACK_FEE_USD`, `CONTEST_EFFORT_USD` | no | `20`, `10` | The cost assumptions in the contest-or-refund expected-value rule. A chargeback costs the seller a fee (we model it as $20); PayPal's actual fee varies. |

**Database security.** The app connects to Postgres as the table **owner** through the pooler (`DATABASE_URL`), and only that way: never use the Supabase client or the anon key with this database. Migration `0001_enable_rls.sql` enables Row Level Security with no policies on all 12 tables and revokes `anon` and `authenticated` privileges, so Supabase's public REST API can read nothing; the owner role bypasses RLS, so the app is unaffected. Apply it with `npm run db:migrate` (safe to repeat).

**Free-tier note.** Keep `LLM_DAILY_CAP` under your provider's daily request limit (check it in the provider's console, for example Groq's). When the provider answers 429 the app tries the optional fallback provider if one is configured, then uses its rule-based results. If you use a paid key, set a spend limit in that provider's console. There is also a limit of 10 model calls per visitor session per hour.

## How it works

Next.js 14 (App Router, TypeScript strict) serves both the UI and the API routes. Drizzle ORM talks to Postgres on Supabase. The login is a single public demo account (NextAuth, JWT); each sign-in gets its own session id, which tags the rows it creates and keys the per-session model limit.

1. **Score.** A PayPal sandbox order is captured, then six signals are evaluated (country mismatch, first-time buyer with a high value, rush shipping, much larger than the merchant's usual order, disposable email, repeated payment attempts). Their weights add up to a 0 to 100 score and a verdict: Ship, Verify first or Hold. The pure rule engine is the only place a score is computed.
2. **Explain.** The model writes the explanation and a buyer-verification draft through a pinned tool call whose output is validated with zod. The model has no write tools of any kind.
3. **Decide on a dispute.** The app builds the evidence vault (order, PayPal, tracking, invoice), scores its completeness, and computes a base win probability from a rubric. The expected-value rule (the chargeback costs a fee, which we model as $20) contests only if `p × amount − (1 − p) × fee − effort > 0`. The model may adjust the probability by at most ±0.1 and write a draft response.
4. **Approve.** Nothing reaches PayPal (or is simulated) unless an approval record exists. A partial unique index prevents a second approval of the same action; a failed live call is retried with the same `PayPal-Request-Id`.
5. **Learn.** After enough recorded outcomes the app proposes a change to the signal weights, with the reasoning. The merchant approves or rejects it.

Every step is recorded in the **Agent Activity** log (PayPal call, model call, rule engine, merchant action), with inputs scrubbed of personal data.

## Tests and checks

```powershell
npm run typecheck; npm run lint; npm test        # over 880 unit and integration tests
npm run db:check; npm run db:seed:verify          # database and seed
npm run qa:live      # API checks against a running server (DEMO_MODE=true)
npm run qa:browser   # headless-browser checks at 375, 768 and 1280 px, including the full demo script
npm run qa:smoke     # read-only checks, safe to point at the production URL (QA_BASE=https://...)
npm run qa:budget -- --print-cap   # the model-budget guard, end to end (see DEPLOY.md)
```

## Tech

Next.js 14, React 18, TypeScript, Tailwind CSS 3, Drizzle ORM, PostgreSQL (Supabase), NextAuth, zod, Vitest, PayPal REST API (sandbox), an OpenAI-compatible chat API (Groq), Vercel.

## Licence

Hackathon project. No licence has been chosen yet.
