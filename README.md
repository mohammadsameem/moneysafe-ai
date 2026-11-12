# MoneySafe AI

**The risk desk for micro-merchants.**

<p align="center">
  <img width="254" height="254" alt="MoneySafe AI Hooded Mascot Logo" src="https://github.com/user-attachments/assets/7221a6e5-5bbd-4ab2-886d-79dcc112c05c" />
</p>

MoneySafe AI scores each PayPal order for chargeback risk with explainable, rule-based signals, and helps a small seller decide whether to contest or refund a dispute. An LLM writes the plain-language explanations and draft messages; it never sets a score and never sends anything. Every action that would reach PayPal waits for the merchant's explicit approval.

- **Live demo:** https://moneysafe-ai.vercel.app
- **Demo video:** https://youtu.be/yLPY8kPuOhI?si=ulhbAyoq02Xtb9Fl

## Try it in 60 seconds
 
Sign in with the public demo account (sample data only; the login page shows the same details):
 
| | |
|---|---|
| Email | `demo@moneysafe.ai` |
| Password | `helloadmin` |
 
1. On the **Dashboard**, click **Start demo**. You get your own copies of three example disputes.
2. Open **Disputes**, then the **$145** dispute ("Your copy of SEED-C", 95% win likelihood, Contest).
3. Click **Approve**. The PayPal call is simulated and badged "Simulated".
4. Choose **Simulate outcome**, then **Won**.
5. Watch **Dollars protected** on the Dashboard and the **Insights** page update.
**Restart my demo** undoes only your own changes. **Reset everything for all judges** resets the shared database (10-second cooldown).
 
## How we use PayPal and AI
 
**PayPal developer platform (sandbox)**
- **Orders API:** create an order, send the buyer to approve it, capture the payment.
- **Add tracking:** the tracking number entered when an order ships is sent to PayPal for real sandbox orders.
- **Customer Disputes API:** reads real sandbox disputes (list and show), displays PayPal's status, stage, due date and allowed actions, and sends a live **accept-claim (refund)** through the approval gate.
**AI (Groq, `openai/gpt-oss-120b`, through an OpenAI-compatible API)**
- Writes the risk explanation, the buyer-verification draft, the dispute analysis adjustment, the draft response and the Insights summary.
- Answers only through pinned tool calls whose output is validated with zod. It has no write tools of any kind.
- Can adjust a win probability by at most 0.1, or override the contest-or-refund recommendation with a stated reason. Scores and probabilities are computed by code, not by the model.
- If the model is unavailable, over budget or returns something invalid, the app shows the rule-based result and says "AI unavailable".
**Built with:** Kiro (spec-driven development) and Claude (planning and review) during development.
 
## What is live and what is simulated
 
This runs on PayPal's **sandbox**. Please read this before judging what you see.
 
**Live**
- Sandbox order create, buyer approval and capture; add-tracking for real sandbox orders.
- **Real sandbox disputes:** **Check PayPal for disputes** (live mode only) reads a dispute opened by a sandbox buyer and links it to a captured order owned by the signed-in session. No other visitor can see or act on it.
- **A live refund on a real dispute, accepted by PayPal** (see below).
- Risk scoring (six weighted signals, one implementation in `src/lib/scoring`), evidence completeness, win probability and the expected-value rule.
- Live model calls (Groq), the approval gate and idempotency, and the model-budget guard.
**Simulated and labelled**
- The 10 seeded orders and 8 seeded disputes, and the copies Start demo creates, are example data. Approving one simulates the PayPal call ("Simulated" badge).
- Won / Lost outcomes are simulated with the "Simulate outcome" control and labelled everywhere. Dollars protected shows the simulated part separately.
- Carrier scan events are mocked; no tracking provider is integrated.
- The history the learning loop starts from is seeded.
**Not implemented or not proven**
- PayPal's make-offer response is not implemented.
- A live evidence submission has not been run: PayPal did not allow it at the stages our real disputes reached, so the app offers only the actions PayPal's `allowed_response_options` permits.
### Real sandbox disputes we ran
 
- **$120 "not as described": a live refund.** There was no evidence on file, so the system recommended a refund. The merchant approved, the app asked for confirmation ("This refunds the buyer $120.00 through PayPal"), and a live accept-claim went to PayPal through the approval gate. Agent Activity logged `approve_dispute_action` and `accept_claim` as success, with no "Simulated" badge, and on the buyer's side PayPal shows "Case closed: the seller has sent you a full refund" for $120.00. The same dispute page then reads "Action already executed", and approving twice is safe.
- **$2,600 chargeback: the AI overrides the rule.** The system recommended contest. The AI changed it to refund because the carrier scans stopped at "Label Created", and the page shows that reason. PayPal allowed nothing this app can send at that stage, so no action button was offered.
- **$230 inquiry: an earlier refund picked up.** PayPal showed it already resolved by a seller refund that predated our call. The app's own accept-claim returned HTTP 422, most likely because the dispute had closed; it showed PayPal's error details and kept Retry. The next sync marked it "Resolved on PayPal", with no approval, execution or learning-loop entry.
**Also worth knowing**
- A real order or dispute belongs to the session that owns the matched order; other visitors get a 404.
- The demo shares one database. Signal weights and the pending weight proposal are shared by everyone.
- The AI budget is limited (`LLM_DAILY_CAP`). When it is used up, everything still works with rule-based text.
- The risk score is a sum of explainable signals. It is **not** a trained fraud model.
- Draft responses say "The evidence on file includes ..." because the app sends text only, never files.
## How it works
 
Next.js 14 (App Router, TypeScript strict) serves the UI and the API routes. Drizzle ORM talks to Postgres on Supabase. Login is a single public demo account (NextAuth, JWT); each sign-in gets its own session id, which tags the rows it creates.
 
1. **Score.** Six signals (country mismatch, first-time high-value buyer, rush shipping, much larger than the usual order, disposable email, repeated payment attempts) add up to a 0 to 100 score and a verdict: Ship, Verify first or Hold.
2. **Explain.** The model writes the explanation and a buyer-verification draft.
3. **Decide on a dispute.** The app builds the evidence vault, scores its completeness, and computes a base win probability. It recommends contesting only if `p x amount - (1 - p) x fee - effort > 0` (we model the chargeback fee as $20; PayPal's actual fee varies).
4. **Approve.** Nothing reaches PayPal unless an approval record exists. A partial unique index prevents a second approval of the same action, and a retry reuses the same `PayPal-Request-Id`.
5. **Learn.** After enough recorded outcomes the app proposes capped changes to the signal weights, with reasoning. The merchant approves or rejects.
Every step is recorded in the **Agent Activity** log, with personal details scrubbed.
 
## Run it locally
 
You need Node 18.17 or newer (Next.js 14's minimum; only run here on Node 26), a Postgres database (a free Supabase project works) and, optionally, PayPal sandbox and LLM keys. Without the optional keys everything runs on seeded data and rule-based text.
 
```powershell
Copy-Item .env.example .env.local   # then fill in DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, DEMO_PASSWORD
npm install; npm run db:migrate; npm run db:seed; npm run dev
```
 
On macOS or Linux use `cp` instead of `Copy-Item` and `&&` instead of `;`. Open http://localhost:3000. For the seeded demo without PayPal, set `DEMO_MODE=true`. To deploy, follow [DEPLOY.md](DEPLOY.md).
 
### Environment variables
 
Copy `.env.example` for the commented template. Never commit `.env.local`.
 
| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection for the app (Supabase transaction pooler, port 6543). |
| `DIRECT_URL` | for migrations | | Postgres connection for `drizzle-kit` (Supabase session pooler, port 5432). |
| `NEXTAUTH_SECRET` | yes | | Signs the session cookie (16+ random characters). |
| `NEXTAUTH_URL` | yes | `http://localhost:3000` | The app's public URL. |
| `DEMO_PASSWORD` | yes | | The public demo login password. |
| `DEMO_MODE` | no | `false` | `true` simulates every PayPal write and creates scored demo orders without PayPal. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | for live PayPal | | Sandbox app credentials (enable Customer disputes on the app for the Disputes API). |
| `LLM_API_KEY` | no | empty | Model provider key. Empty means no model is called; every AI feature shows its rule-based result. |
| `LLM_BASE_URL`, `LLM_MODEL` | no | see note | Any OpenAI-compatible endpoint and model. We run Groq (`https://api.groq.com/openai/v1`, `openai/gpt-oss-120b`). Set both: the built-in defaults are a different provider we have not verified. |
| `LLM_FALLBACK_*` | no | off | Optional second provider, tried once if the first fails. Tested with mocked HTTP only, so we do not claim one. |
| `LLM_DAILY_CAP` | no | `200` | Model calls per UTC day across all visitors (also 10 per session per hour). |
| `CHARGEBACK_FEE_USD`, `CONTEST_EFFORT_USD` | no | `20`, `10` | Cost assumptions in the contest-or-refund rule. |
 
**Database security.** The app connects to Postgres as the table owner through the pooler and only that way; never use the Supabase client or the anon key with this database. Migration `0001_enable_rls.sql` enables Row Level Security with no policies on all 12 tables and revokes `anon` and `authenticated` privileges, so Supabase's public REST API can read nothing. Apply it with `npm run db:migrate` (safe to repeat).
 
## Tests and checks
 
```powershell
npm run typecheck; npm run lint; npm test        # over 970 unit and integration tests
npm run db:check; npm run db:seed:verify          # database and seed
npm run qa:live      # API checks against a running server (DEMO_MODE=true)
npm run qa:browser   # headless-browser checks at 375, 768 and 1280 px, including the demo script
npm run qa:smoke     # read-only checks, safe against production (QA_BASE=https://...)
npm run qa:budget -- --print-cap   # the model-budget guard, end to end (see DEPLOY.md)
```
 
## License
 
MIT. See [LICENSE](LICENSE).
 
