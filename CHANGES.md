# Changes

Notable changes to the spec and architecture, newest first. Task-by-task progress lives in `tasks.md`; this file records decisions that changed direction.


## Deviation log
One line per deviation from the written specs, newest first.
- 2026-11-10 M4-09 / REQ-NFR-17 (LLM fallback): the fallback provider as configured (Gemini, `gemini-3.8-flash`) times out at 8 s from this machine (`npm run llm:check`), so with an invalid primary the app degrades to the rule-based result after about 9 s per call instead of being answered by the second provider; the degraded path works (order created, note shown), the "second provider answers" path is covered by unit tests only. Pick a fallback model that answers, or leave `LLM_FALLBACK_API_KEY` empty.
- 2026-11-10 M4-09: the demo script, the LLM modes (`npm run qa:llm`) and the live-write error path (`npm run qa:livewrite`, needs `DEMO_MODE=false`) are automated; `npm run qa:live` needs `DEMO_MODE=true` and `npm run qa:livewrite` needs it off, so they cannot share one server.
- 2026-11-09 M4-08b: the budget-guard check cannot literally set `LLM_DAILY_CAP=3`, because the daily counter is global, shared by every deployment on the database and never reset, so on a day with prior use a cap of 3 is already exhausted; `npm run qa:budget` reads today's usage and the cap to start the server with is `used + 3` (`-- --print-cap`), which tests the same thing (the first calls spend the budget, later ones fall back with `llm_budget_exceeded`).
- 2026-11-09 M4-09 step 4 / REQ-RISK: the order detail page now says why an amount-based signal fired ("$320.00 > 3 × $85.00 usual order = $255.00"; "$210.00 > $200.00 for a first-time buyer"); the demo script requires the "$320 > $255 threshold shown" and the page did not show it.
- 2026-11-09 QA / browser script: `npm run qa:browser` now runs as independent sections (`QA_SECTIONS=start,pages,hero,tabs,reset,missing,feed,feedvisible,feedfaults,feedoutage`), each with its own tab, a hard 90 s limit and a hang report (last step, open requests, last 20 page events); the earlier "hang" was the script's in-flight counter drifting (a redirect and browser-injected traffic left it above zero, so every page load waited out a 12 s cap), not the app.
- 2026-11-09 REQ-AA-02 (activity feed): polling moved to `usePoll` (`src/lib/activity/polling.ts`, rules in `poll-state.ts`): no request at mount, no overlapping requests, paused while the tab is hidden, one failure shows a quiet "Refresh delayed, retrying" that clears on the next success, three in a row show "Could not refresh; still trying", a 401 shows "Your session has ended" and stops polling; the original showed one persistent error text for every failure kind and fetched twice at mount.
- 2026-11-09 M4-04 / REQ-DASH-03: the Risk distribution card no longer stretches to the height of the activity card beside it, and says "N orders on Hold need attention" when there are any.
- 2026-11-09 M4-06 / REQ-NFR-07: the order and dispute detail pages have no route-level `loading.tsx` (it would make a missing record's 404 a 200, see M2-07); their activity feed streams in behind a section skeleton instead, and the decision panel and feeds sit in section error boundaries. Success messages that used to appear inline are toasts (the panel or card they sat in re-renders or disappears); failures stay on screen as well.
- 2026-11-09 M4-05 / REQ-DU-03 (new): "Restart my demo" (`POST /api/demo/restart`) is a session-scoped reset the spec does not have; it never refreshes the Insights cache, so after it removes outcome rows the page shows a rule-based summary of the current data with a "refreshed after the next resolved dispute" note (a stale cache is no longer reported as "AI unavailable"); it also keeps the global reset's audit row, which is the cooldown marker.
- 2026-11-09 M4-05 / REQ-DU-01: the global reset adds a `reset_demo_global` audit row (so a freshly reset database has 9 activity rows, not 8) and a 10-second cooldown from that row (429 with `Retry-After`); `db:seed:verify` tolerates `reset_demo_*` rows. It also clears approvals, executions, outcomes, evidence and activity completely and re-writes the seed's own, instead of deleting only `is_seed = false` rows as the task wrote, so legacy rows on seed disputes cannot survive.

- 2026-11-09 M4-02 / design 7.4: `POST /api/insights/approve-weights` and `reject-weights` take `{ proposalCreatedAt }` (the proposal the merchant was shown), which the design does not list; a different pending proposal gives 409 `proposal_changed`, so a proposal that was replaced meanwhile can never be decided by mistake.
- 2026-11-09 M4-01 / REQ-LL-02: when the model is unavailable (no key, budget spent, outage, invalid answer) no proposal is stored and the counter is left alone (the tasks wrote "unchanged weights with a note", but a no-op proposal would block real ones until the merchant rejected it); the reason is logged as `proposal_skipped_ai_unavailable`. A valid answer that keeps every weight also stores nothing, but resets the counter (the cycle was reviewed). Learning-loop model calls get 5 s per provider instead of 8 s so Approve / Simulate outcome stay inside their 60 s limit.

- 2026-11-09 M3-08 (new) / REQ-DIS-05, REQ-DEMO-01: "Start demo" copies SEED-C/D/E per session instead of letting every judge approve the one shared row. Approach: a copy is an ordinary `is_demo` dispute owned by the session, with a deterministic id `uuidv5("demo-copy:<session>:<seed id>")` inserted `ON CONFLICT (id) DO NOTHING` (idempotent and race-safe, no schema change; the copy of any seed is found by computing its id, so there is no "copy of" column); it points at the seed's order, so it shares the seed's evidence; it carries the seed's stored analysis (no model call) and a concrete deadline at now + 72 / 48 / 40 h. Deviation: seeds are now read-only (approve / reject return 409 `shared_example`; the open seeds' panel shows "Shared example, use Start demo for your own copy" and a Start demo button), and the Open tab hides a seed once the session has its copy. Tests that used to approve seeds now approve a session-owned demo dispute; executor tests are unchanged (the refusal lives in the approve handler, the only caller). The demo script (M4-09 step 5) now starts with Start demo, and M4-05 must delete the copies.

- 2026-11-09 M3-06 / REQ-DU-02, REQ-DIS-11: a session gets at most one simulated dispute per order (deterministic id from session + order, `ON CONFLICT DO NOTHING`); a second click returns the existing dispute (409 with its id), which makes the button idempotent and race-safe with no schema change. "Simulate outcome" is offered on the session's own `is_demo` disputes after `submit_evidence` ran, whether or not `DEMO_MODE` is set (demo disputes are demo data by definition); it is never offered on seeded, real or refunded disputes.

- 2026-11-09 M3-03 / REQ-EV-01: seeded orders cannot be shipped and their evidence cannot be appended to (409 `shared_example`); they are shared by every session, so changing one would change it for everyone. Shipping works on the session's own orders (sandbox or demo). The real PayPal add-tracking call is implemented but unverified: no sandbox order has ever been captured.

- 2026-11-09 M3-01 / REQ-EV-01: no real carrier tracking API is integrated. AfterShip, TrackingMore and 17TRACK all require an account and an API key created by the project owner, which cannot be done unattended. Tracking events always come from the deterministic mocked provider and are labelled `isMocked: true` ("mocked" badge); `TrackingProvider` is the adapter a real one would implement.

- 2026-11-08 REQ-DIS-05 / M2-07: a live (not simulated) approval asks for one confirmation in the panel before it is sent; simulated approvals do not. The detail page has no route-level skeleton (it would turn a missing dispute's 404 into a 200); the analysing state is the skeleton.

- 2026-11-08 REQ-DEMO / seed: 8 hand-written `agent_activity` rows are seeded (src/seed/activity.ts) so the dashboard feed and /activity are not empty on first load. agent_activity has no is_seed column, so seeded rows are identified by deterministic `seedId("activity", ...)` ids and the marker session id `seed-demo`, and every output summary starts with "Demo data:". Reset demo (M4-05) restores them by id.

- 2026-11-08 BUG FIX src/db/client.ts: `max_pipeline: 1`. postgres.js pipelines several queries on one connection by default, and through the Supavisor transaction pooler a pipelined query hangs until statement_timeout (2 min), holding its transaction open, even on unrelated rows (measured: 2 concurrent queries on a 1-connection pool hang). On Vercel (`max: 1`) any two overlapping queries in one instance would have hung. With the fix, 20 concurrent same-row updates finish in under a second; a regression test runs 16 concurrent queries through the real pool.
- 2026-11-08 REQ-NFR-14 / M2-03: `analysis_computed_at` doubles as an in-flight claim (`pending:<ISO>|<id>`), taken atomically before any model call; only the claim winner spends LLM budget, and a simultaneous request waits (up to 45 s) and returns the winner's result, or 202 `in_progress`. A failed winner releases the claim; a claim older than 90 s (or malformed) is taken over. Every reader treats a claim as "not analysed".

- 2026-11-08 REQ-NFR-13 / M1-09: every provider now gets at most 8 s per structured call in total (the pinned attempt and the JSON-only retry share it), replacing the 30 s default and the per-caller 12 s overrides. Worst case per call is 2 providers x 8 s = 16 s.
- 2026-11-08 REQ-NFR-04: recommended provider order is Groq primary, Gemini fallback (Gemini timed out or returned 503 in testing). The code defaults are unchanged; `.env.example` and `DEPLOY.md` now show Groq as primary. `.env.local` was swapped by script, without printing any value.
- 2026-11-08 REQ-NFR-18 / routes: a test now requires every route that can reach a model to export `maxDuration` (60) and checks that the worst case plus a 15 s margin fits. Vercel docs (page dated 2026-08-24): with Fluid compute Hobby defaults to and is capped at 300 s; the older limit was 60 s, which 60 satisfies.

- 2026-11-08 M2-04: the action to approve is derived from the final recommendation (contest -> submit_evidence, refund -> accept_claim), not chosen by the client; a request for the other action is 409. Approving a refund takes no edited draft.
- 2026-11-08 M2-04 / REQ-DIS-09: `accept_claim` completion marks the execution done, resolves the dispute, inserts the `dispute_outcomes` row (ON CONFLICT DO NOTHING) and bumps the counter in ONE transaction, and the counter moves only if that row was inserted. The "run learning loop check" step is an unbound `onOutcomeRecorded` hook until M4.
- 2026-11-08 M2-05 before M2-04: built first because the M2-04 tests exercise the real executor. `submitEvidence` / `acceptClaim` keep their M1-06 signatures; the approve handler passes the approval and execution it already holds to `executeApproved` (src/lib/disputes/executor.ts) instead of the PayPal functions loading the row themselves.
- 2026-11-08 REQ-DIS-03 / M2-02: an AI override of the recommendation is ignored when its reasoning is shorter than 20 characters; an override equal to the system's recommendation is not an override. The tool asks for llm_adjustment in -0.1..0.1; the zod schema tolerates +/-0.5 and the system clamps.
- 2026-11-08 M2-03 / design 7.3: `analyze` does not call `paypal.getDispute` first. The deadline refresh from PayPal for a live-linked dispute happens in the read layer (M2-01); analysis needs only the local dispute and its order's evidence.
- 2026-11-08 M2-02 / design 5.4: the dispute tool schemas also cap the evidence lists (12 items, 160 characters each); an optional override is simply not listed in `required` (no `["string","null"]` type, which Gemini's OpenAI layer may reject).

- 2026-11-08 REQ-NFR-18 / M1-09b: `GET /api/orders/paypal-return` and `/paypal-cancel` redirect (302) to `/login` when there is no session, instead of 401 JSON; every other `/api/*` route is unchanged. Reason: they are browser navigations from PayPal.
- 2026-11-08 REQ-AUTH-02 / M1-11: the login page prints the demo email and the value of `DEMO_PASSWORD` in a "Demo login" box (public by design). Anyone who can open `/login` can read it, so the demo account must hold sample data only.
- 2026-11-08 REQ-ORD-01 / M1-07b: a created (unpaid) order stores `buyer_email = pending@paypal.invalid` because the column is NOT NULL and PayPal reveals the payer's email only at capture.
- 2026-11-08 design 7.1 / M1-07b: orders are bound to the session that created them (`orders.session_id`); a new sign-in gets a new session id, so an unpaid order from an expired session cannot be captured after signing in again.
- 2026-11-08 M1-07b: when PayPal is not used (Demo Mode, no credentials, or a PayPal error), order creation makes an `is_demo` order that is already `captured` and scored (buyer `demo.buyer@example.com`, first-time fixed true).
- 2026-11-08 design 5.4 / M1-09: the explanation and verification schemas also enforce the word limits (120 and 200 words) and a single-line subject, not only the character limits.
- 2026-11-08 M1-09: the buyer's email address is never sent to the model; the prompt builders accept only the fields they use.
- 2026-11-08 M1-01 / next.config.mjs: `postgres` is listed in `experimental.serverComponentsExternalPackages`; bundling it broke `next build` (an `import.meta.url` asset that Terser could not parse).

---

## 2026-11-08: Provider-agnostic LLM layer (free-tier friendly)

**Why.** The LLM layer was written against Anthropic. A paid Anthropic key is not needed to run or demo this app, so the layer now talks to any OpenAI-compatible chat-completions API, which lets the project run on free tiers (Gemini, Groq, OpenRouter, ...). Nothing else in the product changed: the LLM is still optional, still never triggers an action, and every result is still validated with zod.

### What changed

| Area | Before | After |
|---|---|---|
| Environment variables | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` and an optional second provider `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_MODEL`. All optional |
| Client | `@anthropic-ai/sdk` (removed from `package.json`) | Plain `fetch` to `{LLM_BASE_URL}/chat/completions`, no vendor SDK |
| Structured output | Anthropic tool use, `tool_choice: { type: "tool", name }` | OpenAI-style function calling, `tool_choice: { type: "function", function: { name } }` |
| If `tool_choice` is rejected | n/a | One retry on the same provider with JSON-only instructions, JSON parsed from the message |
| Provider failure | rule-based result | Fallback provider tried once (on error, timeout, 429 or 5xx), then the rule-based result |
| `LLM_DAILY_CAP` default | 300 | **200** |
| README note | "Set an Anthropic spend limit" | "Free tier: keep `LLM_DAILY_CAP` under the provider's daily limit" |

### Behaviour (all covered by tests with `fetch` mocked)

- **No key, no LLM.** With `LLM_API_KEY` empty the app never calls a model, makes no network request and uses no budget; every AI feature returns its rule-based result. The primary key is the master switch: a set `LLM_FALLBACK_API_KEY` is ignored while `LLM_API_KEY` is empty.
- **Pinned tool, then JSON.** Each call declares one tool and pins it by name. Only HTTP **400 or 422** counts as "the provider rejected the pinned `tool_choice`" and triggers the single JSON-only retry. A 429, 5xx, 401, timeout or network error goes straight to the next provider instead. A provider that ignores `tool_choice` and answers in plain JSON text is accepted without a second call.
- **Validation always.** Tool arguments and JSON text are both validated with the existing zod schemas. A response that fails validation (or is not JSON) uses the rule-based result and is **not** retried on another provider (REQ-NFR-02).
- **Untrusted-data isolation is unchanged.** The prompt, with its `<instructions>` / `<data>` structure, is sent byte-for-byte as the user message in both the tool attempt and the JSON retry (a test asserts this against a hostile `<data>` section). The JSON-only instruction is a separate static system message.
- **Budget and fallback unchanged in meaning.** `callWithFallback` keeps its contract: not configured, then the per-session and global daily budget gate, then the call, then the rule-based fallback, with `usedFallback = true` driving the "AI unavailable" note and no HTTP 429. One budget unit is used per `callWithFallback`, not per provider attempt.
- **Logging.** One `agent_activity` row per provider attempt, naming the provider (`gemini (primary)`, `groq (fallback)`), model, mode (`tool` or `json`) and outcome (`HTTP 429`, `ok`, `validation failed`, ...). Rows never contain API keys, prompts or provider response bodies (a test feeds an error body that echoes the key and asserts it never appears in logs).

### Provider defaults

Checked against each provider's own documentation on 2026-11-08.

| | Base URL | Model | Source |
|---|---|---|---|
| Primary (Gemini) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-3.8-flash` | Google AI Studio docs: OpenAI-compatibility page, models page, pricing page ("Free of charge" on the free tier) |
| Fallback (Groq) | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` | Groq docs: tool-use page (lists local tool use and JSON mode for this model), models and rate-limits pages |

### Not verified (read before relying on it)

- **Pinned `tool_choice` on Gemini.** Google's OpenAI-compatibility docs only show `tool_choice: "auto"`. Whether a pinned function choice is accepted was not confirmed against the live API (no key was available). If it is rejected, the JSON-only retry handles it, at the cost of one extra request per call.
- **Gemini's free daily request limit.** Google shows the limits for your project only inside AI Studio. A third-party article claims the full Flash models allow only about 20 requests per day on the free tier and the Flash-Lite models about 500; that was not confirmed from an official source. Check AI Studio, and if the number is low set `LLM_MODEL=gemini-3.5-flash-lite` (an official model id) or lower `LLM_DAILY_CAP`.
- **No live provider call has been made.** All behaviour above is tested against a mocked `fetch`. A first real call will exercise the Gemini and Groq wire formats.

### Live smoke test: `npm run llm:check`

Added after the change above, because everything else is tested against a mocked `fetch`. It makes one tiny structured call per provider through the real pinned `tool_choice` path and reports, per provider: label, model id, HTTP status, whether the pinned tool call was accepted (or accepted but answered in text, or rejected so the JSON retry was needed), and PASS/FAIL. It prints no keys, base URLs, query strings or response bodies (any reason is capped at 80 characters). A provider with an empty key is skipped. This answers the two "not verified" items below once it has been run with real keys.

Also fixed while adding it: the client now appends `/chat/completions` to the base URL's *path*, so a base URL with a query string (for example `?api-version=...`) keeps the query at the end.

### Files

- Added: `src/lib/ai/providers.ts`, `chat-completions.ts`, `structured.ts`, `call-with-fallback.ts`, `errors.ts`, and tests in `src/lib/ai/__tests__/` (`structured`, `call-with-fallback`, `providers`, shared `fixtures`)
- Changed: `src/lib/env.ts` (LLM variables, `getLlmEnv()`), `.env.example`, `package.json` and `package-lock.json` (SDK removed), `requirements.md` (v1.8: actors, REQ-ORD-05/06, REQ-DIS-03/04, REQ-LL-02, REQ-NFR-04, REQ-NFR-13, REQ-NFR-17), `design.md` (v1.6: sections 1, 2, 5.1, 5.2, 5.6, 11), `tasks.md` (M1-01, M1-09, M1-09b, M3-07, M4, M5-01)
- Not changed: scoring, database schema, seed data, the approval and idempotency design

### What the implementation deliberately leaves to later tasks

`callWithFallback` takes its collaborators as injected dependencies (`isConfigured`, `checkBudget`, `logActivity`), because the activity logger (M1-08) and the budget check (M1-09b) are separate tasks. The tool definitions, schemas, prompts and explainers (rest of M1-09) are also still to do.

### If you already have a `.env.local`

Add `LLM_API_KEY` (and optionally `LLM_FALLBACK_API_KEY`), delete the `ANTHROPIC_*` lines (they are ignored now), and change `LLM_DAILY_CAP` to 200 if it is still the old 300. Nothing in `.env.local` was modified by this change.
