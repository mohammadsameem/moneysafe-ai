# MoneySafe AI: Devpost draft

_Draft for the submission form. Replace the bracketed placeholders; keep the "What is real" section, it is the part judges can check._

**Tagline:** The risk desk for micro-merchants.

**Links:** Live demo `[URL]` · Code `[repo URL]` · Walkthrough video `[YouTube or Loom URL]` · Technical deep-dive `[URL]`
**Demo login:** `demo@moneysafe.ai` / the password shown on the login page.

## Inspiration

A chargeback costs a small seller the sale, the goods and a fee of around $20 on top, and most micro-merchants have no risk team. They either ship everything and absorb the losses, or they refuse good customers. When a dispute does arrive there is a deadline, a form and no way to know whether contesting is worth the effort. We wanted one screen that says, in plain language, "this order looks risky, and here is exactly why" and later "contest this dispute, or just refund it".

## What it does

MoneySafe AI scores every PayPal order for chargeback risk from six explainable signals and shows which signals fired and how many points each added. When a buyer opens a dispute it gathers the evidence, estimates the chance of winning, and recommends contesting or refunding using an expected-value rule, with a draft response ready to edit. The merchant approves every action before anything is sent, and the Insights page learns from the outcomes: it proposes changes to the signal weights, and the merchant decides whether to adopt them.

The pages: a **Dashboard** (value under review, disputes won, dollars protected, risk distribution), **Orders** (risk score, verdict, AI explanation, buyer-verification draft), **Disputes** (inbox with deadlines; each dispute has an evidence vault, win likelihood, recommendation and approval), **Insights** (outcomes and the learning loop), and **Agent Activity** (a log of every PayPal call, model call, rule and merchant action).

## How it works

- **Score.** A pure rule engine adds up weighted signals into a 0 to 100 score and a verdict (Ship, Verify first, Hold). There is one implementation, and the model cannot change a score.
- **Expected value.** Contest only if `p × amount − (1 − p) × fee − effort > 0`, with the fee and the effort cost as settings. `p` starts from a rubric over evidence completeness, clamped to 5%..95%. The model may adjust it by at most ±0.1.
- **Tool use, not free text.** The model answers through a pinned tool call and its output is validated with zod. If it is unavailable, over budget or returns something invalid, the app shows the rule-based result and says "AI unavailable". It has no write tools of any kind.
- **Approval invariant.** Every PayPal write goes through one gate that needs an approval record. A partial unique index makes a double approval impossible, and a failed call is retried with the same `PayPal-Request-Id`, so a retry cannot act twice.
- **Learning loop.** After enough recorded outcomes the app proposes new weights, with reasoning, and waits for the merchant.

## What is real, and what is simulated

We want to be exact about this, because the demo runs on PayPal's sandbox.

- **Real:** the PayPal sandbox order flow (create, buyer approval, capture) and add-tracking; the risk scoring; the evidence, win-probability and expected-value logic; the model calls (Groq, with an optional Gemini fallback); the approval gate and idempotency; the budget guard.
- **Real disputes:** a sandbox buyer can open a dispute in the Resolution Center. The app reads it through the PayPal Disputes API, matches it to a real captured order in the owner's session only (no other visitor can see or act on it), and shows PayPal's own status, stage, due date and allowed actions. At the inquiry stage PayPal allows a refund or an offer, not evidence, so the app offers the refund and no evidence button. Approval goes through the same approval gate to a live PayPal call, never simulated, with the same `PayPal-Request-Id` on retry. We ran this on a real $230 sandbox dispute: it was linked to the right order, analysed by the live model (5% win likelihood, refund recommended, because that order had not been shipped and so had no evidence), and PayPal's real status and allowed actions were shown.
- **Simulated:** **Start demo** and the seeded disputes are example data, not PayPal disputes. Approving one simulates the PayPal call and carries a "Simulated" badge, and Won / Lost outcomes are simulated with a control and labelled everywhere. Carrier scan events are mocked; there is no tracking provider. The history the learning loop starts from is seeded.
- **Tested against the real sandbox:** reading and matching a real dispute, its live status and allowed actions, and the failure and retry path of a live dispute write (PayPal answers 404, the app reports it, offers Retry, and reuses the same request id).
- **Not yet run:** a successful live refund or evidence submission on a real dispute. That path has only been tested with a mocked PayPal.

## Challenges

- **A dispute only exists once a buyer opens one.** In the sandbox that means a buyer account opening a case in the Resolution Center, so a judge cannot trigger a real one on demand, and a real one can be limited by its stage (at the inquiry stage PayPal does not allow evidence). We built the demo around labelled examples: seeded disputes are read-only shared examples, "Start demo" gives each visitor their own copies, and every simulated step is marked, so a judge can run the whole loop without touching anyone else's data. Real disputes are supported alongside them and kept strictly to their owner.
- **One shared database for many judges.** Seeds cannot be approved, sessions are isolated by copies, the weights are shared on purpose, and there is a "Restart my demo" for you alone and a "Reset everything for all judges" with a cooldown and an audit row.
- **A hang that only showed up through a connection pooler.** Two queries pipelined on one connection through Supabase's transaction pooler left a transaction open until the statement timeout. We measured it and set one query in flight per connection.
- **Free-tier model limits.** A global daily cap and a per-session hourly cap stop a visitor from exhausting the quota; past the cap everything keeps working with rule-based text. We checked it end to end: the calls after the cap are fallbacks, not errors, and the seeded pages need no model at all.
- **A polling bug our own QA caught.** The activity feed showed a permanent "Could not refresh" after one failed request. We reproduced it with injected faults, rewrote the polling (no overlapping requests, paused in a hidden tab, a quiet retry that clears itself, a clean message when the session ends) and now test it in a real browser.

## Accomplishments

- 882 automated tests plus a headless-browser suite that drives the real UI at phone, tablet and desktop widths, including the full demo script after a global reset.
- A seed that verifies itself (`db:seed:verify`), so the demo state is the same every time.
- Model output is never trusted: schemas on the way in, clamps on the numbers, a rule-based answer behind every AI answer.
- Idempotent actions by construction (a unique index and a stored request id), not by hoping nobody double-clicks.
- A read-only smoke test for the production site, and a budget-guard check that runs against any deployment.

## What's next

- Per-visitor database isolation instead of shared weights.
- More dispute reasons than "item not received" and "not as described".
- A real carrier tracking API in place of mocked scan events.
- Run a real dispute through to a successful live refund or evidence submission, and support PayPal's make-offer response.

## Built with

Next.js 14 · React 18 · TypeScript · Tailwind CSS · Drizzle ORM · PostgreSQL on Supabase · NextAuth · zod · Vitest · PayPal REST API (sandbox) · Groq and Gemini (OpenAI-compatible APIs) · Vercel
