# MoneySafe AI — Tasks

> Ordered so the app is demo-able after each milestone.  
> Each task is sized to be completable in one focused coding session.  
> Prefix convention: `M1-`, `M2-`, `M3-`, `M4-`, `M5-`

---

## Milestone 1 — Orders + Risk Badges
**Demo-able after:** Orders list with colour-coded risk badges; seed scores verifiable; all unit tests passing.

---

### M1-01 · Project scaffold

- [x] Initialise Next.js 14 App Router project with TypeScript strict mode
- [x] Add Tailwind CSS and shadcn/ui; configure `components.json` (Tailwind v3 setup, written by hand; see note)
- [x] Add Drizzle ORM with Postgres dialect; configure `drizzle.config.ts` (uses `DIRECT_URL`, falls back to `DATABASE_URL`)
- [x] Add `zod`, `next-auth`, `vitest`, `recharts` dependencies (exact versions). The LLM layer is plain `fetch` against an OpenAI-compatible API, so there is no vendor SDK: `@anthropic-ai/sdk` was removed (see CHANGES.md)
- [x] Create `.env.example` with all variables from design §11 (+ `DIRECT_URL`; the `LLM_*` provider variables replaced `ANTHROPIC_*`)
- [x] Create `src/lib/env.ts` that reads and validates all env vars with zod (lazy `getEnv()`; includes `CONTEST_EFFORT_USD`, `LLM_DAILY_CAP` (default 200) and the optional `LLM_*` provider settings with Gemini/Groq defaults; `getLlmEnv()` reads just those)
- [x] Add `npm run dev`, `npm run db:migrate`, `npm run db:seed`, `npm run test` scripts

> Note: the current `shadcn` CLI generated a Tailwind v4 / Base UI setup that doesn't fit Next 14 + Tailwind 3, so it was rolled back and the classic shadcn config (HSL variables, `clsx` + `tailwind-merge@2`, `tailwindcss-animate`) was written by hand. Components are added later with `npx shadcn@2 add <component>`.

---

### M1-02 · Database schema

- [x] Define Drizzle schema for all 12 tables in `src/db/schema.ts`: `orders` (incl. `paypal_capture_id`), `settings`, `evidence_artefacts`, `disputes` (incl. `deadline_offset_hours`; seeded `deadline_at` placeholder `'2099-01-01T00:00:00Z'`), `approval_records`, `action_executions`, `agent_activity`, `signal_weights`, `dispute_outcomes`, `llm_rate_limits`, `llm_daily_usage`, `insights_cache`
- [x] `llm_rate_limits`: `session_id text PK`, `call_count int NOT NULL DEFAULT 0`, `window_start text NOT NULL`
- [x] `llm_daily_usage`: `day text PK` (`YYYY-MM-DD` UTC), `call_count int NOT NULL DEFAULT 0`
- [x] `insights_cache`: single row — `summary`, `used_fallback`, `input_fingerprint`, `generated_at`
- [x] Seed row for `settings`: `merchant_avg_order_value_usd = 85` **only** (fee and effort come from env, not the table) — seeded by M1-03's runner; verified in the database (`seed-verify`: one settings row, value 85)
- [x] Add partial unique index on `approval_records (dispute_id, action_type) WHERE decision = 'approved'`
- [x] Generate initial migration with `drizzle-kit generate` → `src/db/migrations/0000_init.sql`
- [x] `npm run db:migrate` script (uses `DIRECT_URL`, port 5432)
- [x] Runtime client `src/db/client.ts`: `postgres()` with `prepare: false` on the pooled `DATABASE_URL`; lazy; `ssl: require` for non-local hosts
- [x] `npm run db:check` (`scripts/db-check.ts`): runs `SELECT 1`, lists public tables, verifies the partial index
- [x] **Apply the migration to Supabase and run `npm run db:check`** — verified: migration applied via the Session pooler (`DIRECT_URL`, port 5432; the `db.<ref>.supabase.co` direct host is IPv6-only and did not resolve from the dev machine); `db:check` shows `SELECT 1 -> 1`, the 12 tables and the partial unique index; `npm test` 7 of 7 including the live `SELECT 1`

> Notes: the design's `text(2)`/`text(3)` are `varchar(2)`/`varchar(3)` (Postgres has no length on `text`). The enum-style columns (`status`, `verdict`, ...) are typed unions in TypeScript only; there are no DB CHECK constraints, matching the design.

---

### M1-03 · Seed data

- [x] **Hand-written risk text for the flagged orders (no LLM call).** For SEED-B, SEED-E-ORD and SEED-F, seed `risk_score`, `verdict`, `signal_breakdown` (all six signals with `active` and `weight`), `ai_explanation`, `used_fallback = false`, and (for SEED-B and SEED-E-ORD, which are "Verify first") `verification_draft { subject, body }`. SEED-A and SEED-D-ORD score 0 and need no explanation. This keeps the seeded demo working even when the LLM budget is exhausted.
- [x] Create `src/seed/data.ts` with all canonical seed records (supporting files: `ids.ts` deterministic IDs, `rubric.ts` seed-time mirror of the scoring formulas, `src/lib/insights/fingerprint.ts`):

  **Open-inbox orders (for SEED-C, SEED-D, SEED-E disputes):**
  - **SEED-A**: Order A, $145, returning buyer, standard shipping, US→US, normal email → score **0**, Ship
  - **SEED-B**: Order B, $210, first-time buyer, rush shipping, US billing → UK shipping, normal email → score **55** (country_mismatch 20 + first_time_high_value 20 + rush_shipping 15), Verify first
  - **SEED-D-ORD**: Order D, $38, returning buyer, standard shipping, US→US, normal email → score **0**, Ship
  - **SEED-E-ORD**: Order E, $210, first-time buyer, standard shipping, US billing → CA shipping, normal email → score **40** (country_mismatch 20 + first_time_high_value 20), Verify first
  - **SEED-F**: Order F, $320, returning buyer, rush shipping, US billing → DE shipping, disposable email → score **70**, Hold

  **Open disputes (SEED-C, SEED-D, SEED-E — status = open, no approval records, no action executions):**
  - **SEED-C**: Item not received on SEED-A; full evidence + Delivered tracking; `deadline_offset_hours = 72`; `base_win_probability = 1.000`; `llm_adjustment = 0`; `win_probability = 0.95`; label = Strong; system_recommendation = contest; pre-computed analysis stored; `analysis_computed_at` set
  - **SEED-D**: Not as described on SEED-D-ORD ($38); partial evidence (no tracking events, no buyer comms); `deadline_offset_hours = 48`; `base_win_probability ≈ 0.267`; `llm_adjustment = 0`; `win_probability ≈ 0.267`; label = Weak; system_recommendation = refund; pre-computed analysis stored
  - **SEED-E**: Item not received on SEED-E-ORD ($210); In Transit tracking only (no Delivered scan); `deadline_offset_hours = 40` (red countdown < 48 h); `base_win_probability ≈ 0.444`; `llm_adjustment = 0`; `win_probability ≈ 0.444`; label = Moderate; system_recommendation = contest (EV positive); pre-computed analysis stored
  - `deadline_at` for seed disputes is computed as `now() + deadline_offset_hours` at read time — never stored as a fixed timestamp

  **Historical resolved dispute orders (H1-ORD through H5-ORD):**
  - H1-ORD: $89, returning buyer, standard, US→US, normal email, score 0
  - H2-ORD: $134, returning buyer, standard, US→US, normal email, score 0
  - H3-ORD: $210, first-time buyer, standard, US→US, normal email, score 20
  - H4-ORD: $42, returning buyer, standard, US→US, normal email, score 0
  - H5-ORD: $67, returning buyer, standard, US→US, normal email, score 0

  **Historical resolved disputes (H1–H5 — status = resolved, outcome set, shown in "Resolved" tab only):**
  - **H1**: Item not received on H1-ORD ($89); full evidence + Delivered; outcome = **won**; `win_probability = 0.95`
  - **H2**: Item not received on H2-ORD ($134); full evidence + Delivered; outcome = **won**; `win_probability = 0.95`
  - **H3**: Not as described on H3-ORD ($210); partial evidence; outcome = **lost**; `win_probability = 0.27`
  - **H4**: Item not received on H4-ORD ($42); partial evidence; outcome = **refunded**; `win_probability = 0.27`
  - **H5**: Not as described on H5-ORD ($67); partial evidence; outcome = **refunded**; `win_probability = 0.27`
  - All H1–H5 have `dispute_outcomes` rows seeded directly; `is_seed = true`

  **Signal weights:**
  - Active row with defaults + a pending weight-change proposal (`proposed_*` fields set, `proposal_created_at` set)
  - `resolved_since_last_proposal = 0` (reset; proposal already pending so counter won't re-trigger)

- [x] Create `src/seed/runner.ts`: idempotent upsert-by-seed-ID logic (deterministic UUIDv5 primary keys + `ON CONFLICT (id) DO UPDATE`, one transaction, consistency guard before any write)
- [x] Implement `npm run db:seed` (`scripts/seed.ts`); verified re-runnable: row counts identical after the second run. Also `npm run db:seed:verify` (`scripts/seed-verify.ts`) prints the verification tables and integrity checks

> M1-03 notes: (1) Seed IDs are deterministic UUIDs because the schema has no seed-ID column. (2) H3's "buyer comms show product mismatch" is carried by the dispute's `buyer_message`, not a communications artefact: a comms artefact would lift H3's base win probability from 27% to 42%, contradicting the 0.27 above. (3) H1–H5 win probabilities are computed from their seeded evidence and stored to 4 decimal places (0.95, 0.95, 0.2667, 0.2667, 0.2667). (4) `insights_cache` has no `is_seed` column, so the Insights page (M4-03) must show the seeded summary with the Demo data badge. (5) `deadline_at` for the three open seed disputes is the placeholder `2099-01-01T00:00:00Z`; the app derives the real deadline from `deadline_offset_hours` at read time (M2-01/M2-03).

---

### M1-04 · Risk scoring engine

- [x] Implement `src/lib/scoring/signals.ts`:
  - `evaluateSignals(order, weights, baselineAvgUsd): SignalResult[]` — `baselineAvgUsd` is always passed in, never queried inside
  - `computeRiskScore(signals): number` — clamp to 100
  - `toVerdict(score): 'ship' | 'verify' | 'hold'`
  - `isDisposableDomain(email): boolean` (blocklist ≥25 domains: mailinator, guerrillamail, yopmail, tempmail, throwaway, sharklasers, trashmail, etc.)
- [x] Implement `src/lib/scoring/evidence-completeness.ts` (pure function, no DB access):
  - `computeEvidenceCompleteness(artefacts: EvidenceArtefact[]): number`
  - Split tracking: +15 if `tracking_events` present (any), +15 if any event has `status = 'Delivered'`
- [x] Implement `src/lib/scoring/win-probability.ts`:
  - `computeBaseWinProbability(completeness, artefacts, reason): number` — rubric per design §6.4
  - `computeWinProbability(base, llmAdjustment): number` — clamp **[0.05, 0.95]** (design §6.4)
  - `toWinLikelihoodLabel(prob): 'Strong' | 'Moderate' | 'Weak'`
- [x] Implement `src/lib/scoring/recommendation.ts`:
  - `computeSystemRecommendation(amount, p, feeUsd, effortUsd): 'contest' | 'refund'`
  - Formula: `p * amount - (1 - p) * feeUsd - effortUsd > 0 ? 'contest' : 'refund'`
  - Also exports `contestExpectedValue(...)` (the EV itself), used by the seed's reasoning text and the future UI
- [x] Export all functions from `src/lib/scoring/index.ts`
- [x] Single implementation: `src/seed/rubric.ts` (the seed-only mirror) was deleted and `src/seed/data.ts` now computes everything through `src/lib/scoring`. Verified behaviour-preserving: the seed bundle at a fixed timestamp is byte-identical (SHA-256) before and after the change. `src/lib/scoring` has no imports from `src/db`.

> M1-04 notes: scoring takes snake_case weights (`SignalWeightValues`, keyed like `signal_breakdown[].signal`), so the caller maps a `signal_weights` row to that shape (M1-10). Extra exports beyond the list: `trackingStatuses`, `DEFAULT_SIGNAL_WEIGHTS`, the threshold constants, `contestExpectedValue`. `toWinLikelihoodLabel` has no unit test in the M1-05 list; it is exercised only by the seed consistency guard, which checks the three open-dispute labels.

---

### M1-05 · Unit tests — scoring

- [x] `src/lib/scoring/__tests__/signals.test.ts` (14 tests):
  - Each signal in isolation (6 tests): verify only the targeted signal fires
  - All 6 signals active → score = 100 (clamp verified)
  - Verdict boundaries: score 39 → 'ship', 40 → 'verify', 69 → 'verify', 70 → 'hold'
  - Seed score assertions (baseline = $85):
    - SEED-A ($145, returning, standard, US→US, normal email) → **0**, 'ship'
    - SEED-B ($210, first-time, rush, US→UK, normal email) → **55**, 'verify'
    - SEED-D-ORD ($38, returning, standard, US→US, normal email) → **0**, 'ship'
    - SEED-E-ORD ($210, first-time, standard, US→CA, normal email) → **40**, 'verify'
    - SEED-F ($320, returning, rush, US→DE, disposable email) → **70**, 'hold'
  - Weight-change test: lower `country_mismatch` to 5 → SEED-B score changes to 40, still 'verify'

- [x] `src/lib/scoring/__tests__/evidence-completeness.test.ts` (4 tests):
  - Full artefacts + Delivered → 100
  - Full artefacts + In Transit only → 85 (missing Delivered +15)
  - No tracking events → 70 (missing events +15 and Delivered +15)
  - No artefacts → 0

- [x] `src/lib/scoring/__tests__/win-probability.test.ts` (7 tests):
  - SEED-C (completeness=100, Delivered, INR) → A=40, B=30, C=20; base = 90/90 = 1.000; `computeWinProbability(1.000, 0)` = **0.95** (upper clamp)
  - SEED-D (completeness≈60, no events, NAD, no comms) → A=24, B=0 (NAD — no delivery bonus), C=0; base = 24/90 ≈ 0.267; `computeWinProbability(0.267, 0)` = **0.267**
  - SEED-E (completeness=75, In Transit, INR) → A=30, B=0, C=10; base = 40/90 ≈ 0.444; `computeWinProbability(0.444, 0)` = **0.444**
  - NAD best-case (completeness=100, buyer comms present) → A=40, B=0, C=10; base = 50/90 ≈ 0.556 (design ceiling for NAD)
  - `computeWinProbability(1.0, 0.2)` = **0.95** (upper clamp at 0.95)
  - `computeWinProbability(0.0, -0.2)` = **0.05** (lower clamp at 0.05)
  - `computeWinProbability(0.5, 0.1)` = **0.6** (no clamp needed)

- [x] `src/lib/scoring/__tests__/recommendation.test.ts` (4 tests):
  - `($145, 0.90, 20, 10)` → 'contest' (EV = 118.5)
  - `($38, 0.40, 20, 10)` → 'refund' (EV = −6.8)
  - `($60, 0.30, 20, 10)` → 'refund' (EV = −6.0)
  - EV = 0 exactly → 'refund' (not strictly positive)

---

### M1-06 · Unit test — no-write-without-approval invariant

- [x] `src/lib/paypal/__tests__/invariant.test.ts` (8 tests):
  - Mock DB: `approval_records` returns no row → `submitEvidence` throws `ApprovalRequiredError`
  - Mock DB: `approval_records` returns no row → `acceptClaim` throws `ApprovalRequiredError`
  - Mock DB: returns approved row → no throw; PayPal call proceeds
  - Beyond the list: a REJECTED row, an approval for a different dispute, an approval for the other action (accept_claim cannot authorise submit_evidence, and vice versa), an empty approval id, and a failing lookup all block the write (fail closed), and in every blocked case the PayPal call is never reached

> M1-06 notes: the test needs `submitEvidence`/`acceptClaim`, whose full implementation is M2-05, so this task adds them as **gated skeletons**: `src/lib/paypal/approval-gate.ts` (`requireApproval`, pure, injected lookup, no `src/db` import), `src/lib/paypal/disputes.ts` (the two write functions; `requireApproval` runs first, then an injected `execute`), and `src/lib/paypal/errors.ts` (`PayPalError`, `ApprovalRequiredError`). M2-05 supplies the real `execute` (load the `action_executions` row, simulate or call PayPal with the stored `PayPal-Request-Id`); the gate does not change.

---

### M1-07 · PayPal service layer — orders

- [x] `src/lib/paypal/client.ts`: OAuth token manager + `request()` helper (token cached, refreshed 60 s before expiry, concurrent callers share one token request, a 401 drops the token and retries once, `PayPal-Request-Id` supported; errors carry PayPal's name / message / `debug_id` but never credentials, tokens or bodies). Fetch and clock are injected
- [x] `src/lib/paypal/orders.ts`: `createOrder` (returns `approvalUrl` from the `payer-action` or `approve` link; return/cancel URLs in `payment_source.paypal.experience_context`), `captureOrder` (returns `captureId`), `getOrder`, `addTracking`, all with zod-validated responses (`types.ts`)
- [x] `src/lib/paypal/demo.ts`: `isDemoMode()`, `shouldSimulateWrite(record)`, `withDemoFallback(liveCall | null, seed, { onFallback })` (DEMO_MODE, missing credentials, or a `PayPalError` return seeded data flagged `isDemo`; a non-PayPal error is rethrown so a bug is not disguised as demo data)
- [x] Custom error classes: `PayPalError`, `ApprovalRequiredError` (`errors.ts`, added in M1-06)
- [x] `GET /api/demo/status`: runs `SELECT 1`; returns `{ demoMode, db: 'ok' }` (200) or `{ demoMode, db: 'error' }` (503) with no error detail. **Exempt from the session check is enforced by the middleware in M1-09b.**
- [x] `src/lib/paypal/index.ts`: the single import boundary, plus `getPayPalClient()` (null when credentials are absent). Tests: 33 (client 11, orders 11, demo 8, status route 3), all with `fetch` mocked

> M1-07 notes: everything is verified against a mocked `fetch` only; no PayPal credentials are in `.env.local`, so nothing has been called live. The add-tracking body (`capture_id`, `tracking_number`, `carrier`, `notify_payer`) follows PayPal's documented field names, but the reference page could not be read in full, so the exact path and payload still need the live check listed in M1-07b.

---

### M1-07b · Real sandbox order flow

- [x] `POST /api/orders` → `paypal.createOrder` with `intent: CAPTURE`, `return_url` = `/api/orders/paypal-return`, `cancel_url` = `/api/orders/paypal-cancel`; insert order as `status = created` with `paypal_order_id`; return `{ orderId, approvalUrl }`
- [x] "New sandbox order" UI on the Orders page: small form (item, amount, shipping method, billing/shipping country) → redirects to `approvalUrl`
- [x] `GET /api/orders/paypal-return?token=…`: look up order by `paypal_order_id`, verify `session_id` matches caller, `paypal.captureOrder` → store `paypal_capture_id` and `status = captured` → ingest + score (settings baseline, active weights) → redirect to `/orders/[id]`
- [ ] On the return path, AI explanation and verification draft via `callWithFallback`: the order flow already takes optional `OrderAiHooks` and saves the rule-based score first; M1-09 supplies the hooks
- [x] `GET /api/orders/paypal-cancel?token=…`: set `status = cancelled`, redirect to `/orders`
- [ ] `paypal.addTracking(paypalOrderId, { capture_id, tracking_number, carrier, notify_payer: false })` implemented against `POST /v2/checkout/orders/{id}/track` (called from the ship route in M3-03). **Confirm the exact path and payload against a real sandbox response** while building this task; adjust `types.ts` if the response differs.
- [ ] Verify against the real sandbox with `DEMO_MODE=false`: create → approve → return → captured → scored. If the sandbox is unreachable, order creation falls back to a seeded record badged "Demo data" (REQ-DEMO-01).
- [x] Cookie config: session cookie `SameSite=Lax` so it survives the PayPal redirect

> M1-07b notes (97 new tests; 210 in total, all offline):
>
> - **Built:** `src/lib/orders/` (`schemas`, `types`, `repo` (Drizzle), `service`, `weights`, `notices`, `runtime`); `POST /api/orders`, `GET /api/orders/paypal-return`, `GET /api/orders/paypal-cancel`; the auth backend the flow needs (`src/lib/auth.ts`, `src/lib/session.ts`, `/api/auth/[...nextauth]`). All I/O in the service is injected, so the rules are tested with an in-memory repo and a fake PayPal client.
> - **Verified live against the real sandbox** (`DEMO_MODE=false`, dev server): demo sign-in (wrong password gives no session; each sign-in gets its own `sid`; cookie is `SameSite=Lax`, `HttpOnly`); `POST /api/orders` creates a real sandbox order (approval URL on `www.sandbox.paypal.com`, row stored as `created`, unscored, tagged with the caller's `sid`); a return before the buyer approves is refused by PayPal and handled (`capture_failed`, order stays `created`); another session cannot return or cancel the order; cancel marks it `cancelled` and a later return does not capture it; no session redirects to `/login`. The test rows were deleted afterwards.
> - **Not verified live (the item above stays open):** the buyer approving in a sandbox buyer account, then a successful capture and scoring. That needs a person in a browser, and the login page and order form land in M1-11. `addTracking`'s path and body are also still unchecked against a real response.
> - **Decisions:** `buyer_email` is NOT NULL but PayPal only reveals the payer's email at capture, so a created order holds `pending@paypal.invalid` (reserved TLD) until then. Only a capture whose status is `COMPLETED` counts as paid. `buyer_is_first_time` is derived at capture from earlier captured/shipped orders with the same email. Capture sends `PayPal-Request-Id: capture-<orderId>` so a retry after a lost response cannot capture twice. Two concurrent returns are resolved by a conditional `created -> captured` update; the loser does not score. If PayPal is not used (Demo Mode, no credentials, or a `PayPalError`), creation makes an `is_demo` order that is already `captured` and scored (buyer `demo.buyer@example.com`, first-time fixed true) and the API returns `approvalUrl: null, isDemo: true, reason`. The item name is not stored locally; the Evidence Vault (M3) reads it from PayPal `getOrder`.
> - **Known limit:** `sid` is new on every sign-in, so an order left `created` by an expired session cannot be captured after logging in again.
> - **Handed on:** M1-08 bound the activity logger (`deps.log`, no more `console.warn` placeholders) and logs each step; M1-09 supplies `OrderAiHooks`; M1-10 can reuse `ingestAndScore` to score a captured-but-unscored order on read.
> - **Build fix (separate commit):** `next build` had been failing since M1-07 because webpack turned `new URL('.', import.meta.url)` in `postgres/src/errors.js` into an asset and Terser could not parse it. `postgres` is now in `serverComponentsExternalPackages` (`next.config.mjs`). The build passes with all five API routes.

---

### M1-08 · Agent Activity logger

- [x] `src/lib/activity/logger.ts`:
  - `logActivity(meta: ActivityMeta): Promise<void>` — inserts to `agent_activity`
  - PII scrub: replace email local-part with `***`
- [x] Export `ActivityMeta` type
- [x] Bind the logger into the order flow: `src/lib/orders/runtime.ts` passes `logActivity` as `deps.log`; the service logs a `paypal_api` row for create and capture (success, error, or `simulated` for the Demo Mode fallback), a `rule_engine` row for scoring, an `llm_call` error row if an AI hook throws, and a `merchant_action` row for cancel. Each row is written after its order exists (`ref_order_id` is a foreign key)

> M1-08 notes (25 new tests; 235 in total):
>
> - `src/lib/activity/pii.ts`: `scrubEmails` (keeps the domain, replaces the local part with `***`, Unicode-aware, linear time) and `summarize` (scrub, collapse whitespace, cap at 500 characters; scrubs before cutting, and bounds its input at a word boundary so a cut can never leave half an email). `logger.ts`: `toActivityRow`, `createActivityLogger(insert)` (testable without a database) and the bound `logActivity`.
> - Logging never throws. A failed write is reported as `could not write an activity row (code NNNNN)`; only the Postgres error code is read, never the message, because it can echo row values. Drizzle wraps the driver error, so the code is read from `err.cause.code` as well (a live check found this: the first version lost the code).
> - `LlmActivityEntry` (from `callWithFallback`) is assignable to `ActivityMeta`, checked at compile time, so M1-09 can pass `logActivity` straight in as `LlmDeps.logActivity`.
> - Checked live against Supabase: a row is written with the email scrubbed and whitespace collapsed; a foreign-key violation is swallowed and reported by code only; test rows removed afterwards.
> - The order flow replaced its `onFallback` / `onWarning` placeholders with the single `deps.log`. The payer's email, item name and approval URL are never put in a summary.

---

### M1-09 · AI client + risk explainer

**Provider-agnostic LLM layer (done; see CHANGES.md).** OpenAI-compatible chat-completions over plain `fetch`, replacing the Anthropic SDK:

- [x] `src/lib/ai/providers.ts`: provider config from `LLM_*` (primary + optional fallback), labelled by host (`gemini`, `groq`); an empty `LLM_API_KEY` yields no providers
- [x] `src/lib/ai/chat-completions.ts`: `POST {baseUrl}/chat/completions` with Bearer auth, 30 s timeout; errors carry only a status, never a response body or key
- [x] `src/lib/ai/structured.ts`: `callStructured` — tool pinned by name (`tool_choice: { type: "function", function: { name } }`); on HTTP 400/422 one JSON-only retry on the same provider; zod validation in every case; primary then fallback provider (once) on error/timeout/429/5xx; a zod failure is not retried elsewhere; one `onAttempt` event per request
- [x] `src/lib/ai/call-with-fallback.ts`: `callWithFallback` — not configured / budget gate / rule-based fallback, one activity row per provider attempt; `isConfigured`, `checkBudget` and `logActivity` are injected
- [x] `src/lib/ai/errors.ts`
- [x] `npm run llm:check` (`scripts/llm-check.ts`, logic in `src/lib/ai/smoke.ts`): ONE tiny structured call per provider (primary and fallback, each on its own, not via the fallback chain) through the real pinned `tool_choice` path with a trivial zod schema. Prints only provider label, model id, HTTP status, pinned accepted / accepted-but-answered-in-text / rejected (+ whether the JSON retry was needed) and PASS/FAIL, with any reason capped at 80 characters; never keys, base URLs, query strings or response bodies. A provider with an empty key is skipped with a message. 10 offline tests. **Live run pending: needs real keys in `.env.local`**
- [x] Tests with `fetch` mocked (26): success; pinned-tool rejection then JSON retry (user message with the `<data>` section byte-identical in both requests); zod failure falls back without trying the second provider; 429 then fallback provider (success, and failure to rule-based); empty key makes no network call; budget denial makes no network call; no keys or provider bodies in logs; env defaults (daily cap 200)

**Remaining for M1-09:**

- [x] `src/lib/ai/tools.ts`: tool definitions for `risk_explanation` and `verification_draft` (name, description, JSON-schema `parameters` kept in step with the zod schemas)
- [x] `src/lib/ai/schemas.ts`: `RiskExplanationSchema`, `VerificationDraftSchema`
- [x] `src/lib/ai/prompts.ts`: `buildRiskPrompt(order, signals)`, `buildVerificationPrompt(order)` with `<instructions>` / `<data>` separation
- [x] `src/lib/ai/risk-explainer.ts`:
  - `explainRisk(...)` — `callWithFallback((ctx) => callStructured({ providers: getConfiguredProviders(), tool: risk_explanation, schema, prompt, onAttempt: ctx.onAttempt }).then(r => r.data), ruleBasedExplanation, meta, deps)`
  - `draftVerification(...)` — same pattern with the `verification_draft` tool and the static template as the fallback
- [x] Bind the real `LlmDeps`: `src/lib/ai/runtime.ts` `getLlmDeps()` = `logActivity` (M1-08) + `checkLlmBudget` (M1-09b) + `isConfigured = () => getConfiguredProviders().length > 0`; `orders/runtime.ts` now sets `deps.ai = createOrderAiHooks({ llm: getLlmDeps() })`

> M1-09 notes (47 new tests; 282 in total, all offline with `fetch` faked):
>
> - **Built:** `schemas.ts` (limits are shared constants: explanation 600 characters and 120 words, subject 100 and single-line, body 1000 and 200 words, per REQ-ORD-05/06), `tools.ts` (`risk_explanation`, `verification_draft`), `prompts.ts`, `rule-based.ts`, `risk-explainer.ts` (`explainRisk`, `draftVerification`), and `orders/ai-hooks.ts`.
> - **Tools and schemas cannot drift:** both read the same limit constants, and a test compares property names, required lists and `maxLength` values. The tool JSON Schema uses only `type`, `description`, `properties`, `required` and `maxLength` (a test enforces this), because Gemini's OpenAI compatibility layer takes an OpenAPI-style subset. Whether Gemini accepts the pinned `tool_choice` is still unverified (`npm run llm:check`).
> - **Prompts:** one `<instructions>` block (never contains order data) and one `<data>` block. Product names are escaped (`& < >`), flattened, and capped at 10 items of 100 characters, so they cannot close `<data>` or open a new section; a test attacks this with `</data><instructions>...`. **The buyer's email is never sent to the model** (the prompt builders accept only the fields they use; the disposable-email result is already a signal), and `order.description` is never included.
> - **Rule-based fallbacks:** deterministic plain-English explanation in the seeded style, and a static verification template that names neither the buyer nor the score. A test runs every one of the 64 signal combinations against all three verdicts and checks each fits the explanation schema.
> - **Behaviour verified with the real `callStructured` and `callWithFallback`:** success pinned to the right tool; JSON-only retry on HTTP 400; 429 then the second provider; both providers down, a failed validation (no second-provider attempt), no key, and a spent budget each return the rule-based text with `usedFallback` and the reason, and the last two make no network call; the activity row carries the order and session but no key, prompt or buyer detail.
> - **Order flow:** the explanation and the draft now run in parallel (`Promise.allSettled`), so a failure in one keeps the other, each model call is capped at 12 s, and `maxDuration = 60` is set on the two routes that can score. `orders.used_fallback` is true if either step used rule-based text.
> - **Not verified live:** no LLM key is in `.env.local` yet, so no real model has been called. The prompts and the 12 s timeout need one real run on each provider.

---

### M1-09b · LLM budget guard + API session protection

- [x] `src/lib/ai/rate-limit.ts`: `checkLlmBudget(sessionId): Promise<{ allowed: boolean; reason?: 'session' | 'daily' }>`
  - Per-session: 10 calls per rolling hour (`llm_rate_limits`; reset when `now() > window_start + 1h`)
  - Global daily cap: `LLM_DAILY_CAP` env (default **200**) against `llm_daily_usage` for the current UTC day
  - Increment both counters atomically in one transaction; only increment when allowed
- [x] `callWithFallback` calls `checkLlmBudget` first (the gate itself is already implemented in `call-with-fallback.ts` against an injected `checkBudget`; this task supplies the real `checkLlmBudget` and binds it). On breach: skip the LLM call, return the rule-based fallback with `usedFallback = true`, log `agent_activity` with `tool_name = 'llm_budget_exceeded'`, `status = 'fallback'`, and `input_summary` naming the limit. **No HTTP 429 anywhere.**
- [x] UI shows the visible note "AI unavailable — showing rule-based result." wherever `usedFallback` is true (order detail page: under the explanation and under the verification draft)
- [x] `src/middleware.ts`: require a valid NextAuth session on every `/api/*` route **except** `/api/demo/status` and `/api/auth/*`; unauthenticated API calls return 401 JSON
  - **Decision applied:** `GET /api/orders/paypal-return` and `/paypal-cancel` are browser navigations from PayPal, so without a session the middleware redirects them (302) to `/login`; every other `/api/*` route still answers 401 JSON. They still require a session (they are not on the open list). 13 tests (`middleware.test.ts`, `api-access.test.ts`), including look-alike paths and sub-paths that must still get 401.
- [x] Add `LLM_DAILY_CAP` to `src/lib/env.ts` and `.env.example` (default 200; verified by `providers.test.ts`)
- [x] Unit tests (`src/lib/ai/__tests__/rate-limit.test.ts`): allowed under both limits; session breach → `{ allowed:false, reason:'session' }`; daily breach → `reason:'daily'`; counters not incremented on breach; session window resets after 1 hour; `callWithFallback` returns the fallback (no LLM call) on breach (this last case is already covered in `call-with-fallback.test.ts` with a fake `checkBudget`)

> M1-09b notes (49 new tests; 333 in total):
>
> - **`checkLlmBudget(sessionId, opts)`**: two single-statement upserts in one transaction. The session row restarts at 1 when its window is more than an hour old (exactly one hour is still the same window), otherwise counts up only while below 10; the daily row counts up only while below `LLM_DAILY_CAP`. If the day is full the transaction is rolled back, so the session is not charged for a call that never happens. Calls with no session id share one bucket. 13 tests: 6 on control flow with a fake db, 7 against real Postgres (window edge at exactly 1 h and 1 h + 1 ms, independence of sessions, rollback leaves no session row, and 15 concurrent calls from one session give exactly 10 allowed; 12 sessions against a cap of 8 give exactly 8). The live tests use far-future 2099 days and unique session ids and delete their rows.
> - **Budget store down fails closed:** `callWithFallback` now catches a throwing `checkBudget` and returns the rule-based result with no model call (new test).
> - **Bug found by the live run and fixed:** fallback rows in `agent_activity` were stored with an empty `tool_name` because an `undefined` toolName overwrote the caller's. Fixed in `callWithFallback`, plus `toActivityRow` stores `unknown` rather than an empty name; regression tests added for both.
> - **Middleware** (`src/middleware.ts`, Edge): 401 JSON `{error:"unauthorized"}` on every `/api/*` except `/api/demo/status` and `/api/auth/*` (rules in `src/lib/api-access.ts`, 22 tests incl. look-alikes such as `/api/authx`, `/api/Demo/status`). It verifies the signed JWT with `NEXTAUTH_SECRET` and requires a `sid`. Cookie naming moved to `src/lib/session-cookie.ts` so the Edge bundle imports nothing Node-only; `npm run build` passes (middleware 48.6 kB). Route handlers still check the session themselves.
> - **Verified live** (dev server, `DEMO_MODE=true` for the run, real Supabase): `/api/demo/status` and `/api/auth/session` open; sessionless and forged-cookie calls get 401; a signed-in `POST /api/orders` makes a demo order scored 60 / verify with the rule-based explanation, the static verification draft and `used_fallback = true`; activity rows are create (simulated), score (success) and two LLM fallbacks naming `risk_explanation` / `verification_draft`; no LLM budget was spent without a key; the demo password appears in no stored row. Test rows were deleted.
> - **Not verified:** a real model call. There is still no `LLM_API_KEY`, so the prompts, the 12 s timeout and a counted budget unit on a real call have not run.

---

### M1-10 · Orders API routes

- [x] `GET /api/orders` — list from DB; include `riskScore`, `verdict`, `isDemo` in response
- [x] `GET /api/orders/[id]` and the PayPal return handler (M1-07b) score via `settings.merchant_avg_order_value_usd`; order creation itself is M1-07b
- [x] `GET /api/orders/[id]` — detail including signal breakdown, AI explanation, `usedFallback`
> M1-10 notes (13 new tests; 346 in total):
>
> - `src/lib/orders/queries.ts`: `toOrderSummary`, `toOrderDetail` and a Drizzle read repo. **Visibility rule:** seeded orders are visible to every session; any other order only to the session that created it. Someone else's order, an unknown id and a malformed id all answer `404 {error:"not_found"}`, so existence is not leaked and a bad id never reaches Postgres. The list is newest first, capped at 200.
> - `GET /api/orders` returns `{ orders: [...] }` with `riskScore`, `verdict`, `isDemo` (true for seeded and demo orders, so the UI can show the "Demo data" badge, REQ-DEMO-07) and `usedFallback`. `GET /api/orders/[id]` returns `{ order }` adding the signal breakdown, AI explanation, verification draft, evidence completeness and shipping/buyer facts. Session ids and PayPal order/capture ids are never returned (tested).
> - Scoring on the PayPal return path already uses `settings.merchant_avg_order_value_usd` and the active weights (M1-07b), and `toSignalWeightValues` (the camelCase-to-snake_case mapping) lives in `orders/weights.ts`. The detail route does not score on read: an order captured but not scored is scored the next time its return URL is opened.
> - Verified against the live database: the list for a fresh session shows exactly the 10 seeded orders plus its own row and not another session's; `findVisible` returns seeds and own rows only. The test rows are deleted afterwards. The two routes themselves were tested with a mocked repo, not over HTTP.


---

### M1-11 · Orders UI

- [x] App layout: sidebar nav (all pages); MoneySafe AI logo + tagline "The risk desk for micro-merchants."
- [x] Login page (`/login`): NextAuth credentials provider against `DEMO_PASSWORD`
- [x] Dashboard placeholder (`/`) with "Coming in M4"
- [x] Orders list page (`/orders`): table (ID, buyer, amount, date, risk badge, verdict, demo badge); sortable; skeleton + empty state
- [x] `<RiskBadge verdict score />`, `<DemoBadge />`, `<SimulatedBadge />` components
- [x] Order detail page (`/orders/[id]`): summary, score display, signal breakdown table, AI explanation card, verification draft card (verify-first only), demo badge
> M1-11 notes (8 new tests; 354 in total; `npm run build` passes):
>
> - **Built with plain Tailwind and no new dependencies** (no shadcn components were added, so the untested `shadcn@2` path stays unused). Files: `src/app/(app)/layout.tsx` (sidebar, logo, tagline, skip link), `(app)/page.tsx` ("Coming in M4"), `(app)/orders/(list)/page.tsx` + `loading.tsx` (skeleton), `(app)/orders/[id]/page.tsx`, `src/app/login/page.tsx`, and in `src/components/`: `badges.tsx` (`RiskBadge`, `DemoBadge`, `SimulatedBadge`), `orders-table.tsx` (sortable), `new-order-form.tsx`, `login-form.tsx`, `sidebar-nav.tsx`. `src/lib/format.ts` holds the pure helpers (tested).
> - **Pages need a session on the server:** the `(app)` layout redirects to `/login`. Next renders a page in parallel with its layout, so the layout is not the only gate: the pages also return nothing without a session (empty list, `notFound`). A signed-out request for `/orders` was checked to carry no order data.
> - **Accessibility basics, not a WCAG audit:** risk badges carry text (and screen-reader text), not just colour; sortable headers are buttons with `aria-sort`; labelled form fields with error text tied by `aria-describedby`; `role="alert"` / `role="status"` for messages; visible focus rings; skip link. Not tested with a screen reader or an automated checker.
> - **Sidebar** shows Disputes, Insights and Agent Activity as disabled "Soon" items rather than links to pages that do not exist yet.
> - **Login page** has a clearly labelled "Demo login" box that shows the public demo email and the value of `DEMO_PASSWORD` (REQ-AUTH-02: public by design; read on the server at request time, never bundled). If `DEMO_PASSWORD` is unset the box says so. The account holds sample data only, so anyone who can open `/login` can sign in; do not reuse that password anywhere else. The form still needs the password typed in. `/login` redirects to `/orders` if you are already signed in.
> - **`loading.tsx` is scoped to the list** with a route group. At the segment level it made a missing order answer 200 instead of 404, because the skeleton streams before `notFound()` runs; found by the live check and fixed.
> - **Verified live** (dev server, real Supabase, signed in with the demo login, `DEMO_MODE=true` for the run): signed-out `/` and `/orders` redirect to `/login`; `/login` renders the form; the list shows all 10 seeded orders each with "Demo data", and the seed scores 0, 40, 55 and 70 as Ship / Verify first / Hold; five sortable headers; the seed verify order shows its signal breakdown, explanation and draft with no fallback note; the hold and score-0 orders show no draft or explanation card; an unknown or malformed order id returns 404; an order made through the form's API shows the "Demo data" badge and the rule-based note; an unknown `?notice=` value is ignored.
> - **Not verified:** how the pages look and behave in a real browser (layout, mobile width, the sort buttons, the `<details>` form, the login redirect after a click). The checks fetched server-rendered HTML; no browser was driven. Client-side sorting is covered by unit tests of `sortOrders` only.
> - **Still open from M1-07b:** a full sandbox payment (create, approve as the buyer in PayPal, return, capture, score) needs a person in a browser with a sandbox buyer account. The form is now there to start it.


---

### M1-12 · Minimal Vercel + Supabase deploy

- [ ] Create Supabase project; set `DATABASE_URL` in `.env.local`
- [ ] Run `npm run db:migrate` and `npm run db:seed` against Supabase
- [ ] Create Vercel project; configure all env vars; deploy
- [ ] Verify orders list loads with SEED-A, SEED-B, SEED-F visible and correctly badged
- [ ] Commit and note the public URL for M4-08

---

## Milestone 2 — Dispute Inbox + AI Verdict
**Demo-able after:** Dispute inbox loads; opening a dispute triggers analysis; merchant can approve/reject.

---

### M2-01 · PayPal service layer — disputes (read)

- [x] `listDisputes()`: `GET /v1/customer/disputes` with Demo Mode fallback + zod validation
- [x] `getDispute(id)`: `GET /v1/customer/disputes/{id}` with Demo Mode fallback + zod validation


> M2-01 notes (28 new tests; 398 in total):
>
> - **`src/lib/paypal/disputes-read.ts`**: `listDisputes(client, {pageSize, disputeState})` (page size clamped to 1-50) and `getDispute(client, id)` (id URL-encoded), both zod-validated; an item without a `dispute_id` is rejected, not trusted. Both are re-exported from `src/lib/paypal`.
> - **`src/lib/disputes/`**: `deadline.ts` (`computeDeadline`, `formatCountdown`), `read.ts` (`listDisputeViews`, `getDisputeView`, `toDisputeView`), `repo.ts` (Drizzle read repo), `types.ts`. The local `disputes` table is the system of record (like orders); PayPal is consulted only for a dispute that has a `paypal_dispute_id` and is not seeded or demo.
> - **Deadline offsets are computed at read time:** an open seed dispute shows `now + deadline_offset_hours` on every read (the stored `2099-01-01` placeholder is never shown). Non-seed disputes keep their stored deadline. An offset of 0 means now.
> - **Countdown rule (REQ-DIS-02):** red/urgent when less than 48 hours remain; exactly 48 h is not urgent; overdue and unparseable dates are urgent.
> - **Open vs Resolved (REQ-DIS-01):** a dispute is on exactly one tab. `action_taken` (evidence sent, awaiting PayPal) is not resolved, so it stays on Open. Open sorts by deadline ascending; Resolved by resolved date descending (`updated_at`).
> - **Fallback (REQ-DEMO-01):** for a live-linked dispute the deadline comes from PayPal's `seller_response_due_date`; if PayPal fails, there are no credentials, or `DEMO_MODE=true`, the stored record is used and a `simulated` `paypal_api` event is logged. A non-PayPal error (a bug) is rethrown, not hidden.
> - **Verified against the live database:** a fresh session sees exactly 3 open and 5 resolved seeded disputes; open deadlines are 40, 48 and 72 hours away (SEED-E, SEED-D, SEED-C) and every open seed already has a stored analysis; resolved outcomes are 2 won, 1 lost, 2 refunded.
> - **Not verified:** the PayPal list/get calls against the real sandbox (the sandbox cannot be given a dispute from this app; tested with a mocked `fetch` only), and the `seller_response_due_date` field name against a real response.

---

### M2-02 · Dispute analysis engine

- [x] `src/lib/ai/schemas.ts` additions: `DisputeAnalysisSchema`, `DraftResponseSchema`
- [x] `src/lib/ai/tools.ts` additions: `dispute_analysis`, `dispute_draft_response` tool definitions
- [x] `src/lib/ai/prompts.ts` additions: `buildDisputeAnalysisPrompt` (includes `base_win_probability` and `system_recommendation` in `<data>`), `buildDraftResponsePrompt`
- [x] `src/lib/ai/dispute-analyst.ts`:
  - `analyseDispute(dispute, artefacts, base, systemRec)` — `tool_choice: { type: 'tool', name: 'dispute_analysis' }`; clamps `llm_adjustment`; computes `win_probability`, label, `final_recommendation`, `recommendation_source`
  - `draftDisputeResponse(dispute, artefacts)` — `tool_choice: { type: 'tool', name: 'dispute_draft_response' }`
  - Both use `callWithFallback`


> M2-02 notes (64 new tests; 462 in total, all offline with `fetch` faked):
>
> - **Built:** `schemas.ts` (`DisputeAnalysisSchema`, `DraftResponseSchema`), `tools.ts` (`dispute_analysis`, `dispute_draft_response`), `prompts.ts` (`buildDisputeAnalysisPrompt`, `buildDraftResponsePrompt`), `rule-based.ts` additions, `dispute-analyst.ts` (`assessDispute`, `analyseDispute`, `draftDisputeResponse`, `fallbackDraft`). `tool_choice` is the OpenAI form, pinned by name, as everywhere else (the `{ type: 'tool', name }` form in the task text is the retired Anthropic one; see CHANGES.md).
> - **The system owns every number.** `assessDispute` (pure) computes completeness, base win probability, the EV and the recommendation from `src/lib/scoring`. The model returns only an adjustment, reasoning, an optional override and two short lists. New pure helpers live in `src/lib/scoring`, not beside the model code: `clampLlmAdjustment` (to +/-0.1; NaN or Infinity count as 0) and `resolveFinalRecommendation`. The tool asks for -0.1..0.1; the zod schema tolerates +/-0.5 and the system clamps (spec).
> - **Override rules:** a different override wins and is labelled `ai_adjusted`; an override equal to the system's is not an override; **an override whose reasoning is under 20 characters is ignored** (the merchant must be told why; this is a small addition to REQ-DIS-03).
> - **Fallback (REQ-DIS-03):** no key, spent budget, provider outage or an answer that fails validation gives the system recommendation, `win_probability`, `llm_adjustment` and the label all null (so the UI shows no meter), a rule-based reasoning ending \"The AI step was unavailable...\", and evidence lists from the shared label functions. The draft falls back to a factual template built from the evidence on file.
> - **Untrusted input:** the buyer message is escaped, capped at 1000 characters and only placed in `<data>`. The model is sent counts of messages, never their text, and never the buyer's email, name or address (tested). The seed and the live analysis now share one set of evidence label functions (`src/lib/evidence/labels.ts`); a SHA-256 of the seed bundle at a fixed timestamp was identical before and after the move.
> - **No write tool is reachable from the model:** a test fails if any file under `src/lib/ai` imports the PayPal layer, and another asserts the tool list is exactly the four read-only tools with no action-like names.
> - **Also added:** `getCostAssumptions()` in `env.ts` (fee 20 and effort 10 by default; a bad value throws naming the variable, not the value), `src/lib/evidence/summary.ts` (facts and prompt lines from artefacts, tolerant of malformed payloads), and `callStructured` now accepts schemas with `.transform()`.
> - **Not verified:** no real model has answered a dispute prompt yet. That is covered by the live check in M2-03, which runs the whole analysis through the real providers.

---

### M2-03 · Dispute analysis API

- [x] `POST /api/disputes/[id]/analyze`:
  - Guard: return cached if `analysis_computed_at IS NOT NULL`
  - Fetch dispute (PayPal or Demo); fetch artefacts from DB
  - `completeness = computeEvidenceCompleteness(artefacts)` (pure fn from M1-04)
  - `base = computeBaseWinProbability(completeness, artefacts, dispute.reason)`
  - Read settings → `systemRec = computeSystemRecommendation(amount, base, fee, effort)`
  - `ai.disputeAnalyst.analyseDispute(...)` — clamp, compute final fields
  - If `final_recommendation = 'contest'`: `ai.disputeAnalyst.draftDisputeResponse(...)`
  - Write all fields; set `analysis_computed_at`; log all steps


> M2-03 notes (16 new tests; 478 in total):
>
> - **`POST /api/disputes/[id]/analyze`** (`src/app/api/disputes/[id]/analyze/route.ts`, logic in `src/lib/disputes/analyze.ts`, wiring in `runtime.ts`). Returns `{ status: "cached" | "analyzed", usedFallback?, dispute }`; 401 without a session, 404 for an unknown, malformed or other session's dispute. `maxDuration = 60`; each model call is capped at 12 s per provider.
> - **Cached (REQ-NFR-14):** a dispute with `analysis_computed_at` set returns its stored analysis and makes no model call and spends no budget. All three open seeds are cached. An analysis stored without AI is cached too (the model is not retried automatically).
> - **Fresh dispute:** `assess_dispute` (pure: completeness, base win probability, EV, system recommendation) -> `dispute_analysis` -> `dispute_draft_response` only when the FINAL recommendation is contest (so a model override to refund skips the draft, and an override to contest adds one). Saved once with `WHERE analysis_computed_at IS NULL`: of two simultaneous requests the loser discards its result and returns the winner's. Stored: `base_win_probability` (4 decimals), `llm_adjustment`, `win_probability`, label, system/override/final recommendation, source, reasoning, evidence lists, `draft_response`, `risk_score_snapshot` (the order's score).
> - **The view now exposes `llmAdjustment`** (null when the AI step was unavailable) so the UI can say how far the model moved the estimate.
> - **Verified live** (dev server, real Supabase, real providers, signed in): no session 401; unknown and malformed ids 404; another session's dispute 404; SEED-C, SEED-D and SEED-E return `cached`, and for SEED-C no LLM budget was spent and no activity rows were written; a fresh un-analysed demo dispute on SEED-A's order was analysed through the real providers (Gemini errored, Groq answered both calls): base 1.0, win 0.95 Strong, contest, system source, a 65-word reasoning, an 812-character draft that cites the real tracking number and contains no buyer email or name, a row with `analysis_computed_at` and the risk snapshot, activity rows `assess_dispute`, `dispute_analysis` (error then success), `dispute_draft_response` (error then success), `save_analysis`; a second POST was `cached` and spent no further budget. The temporary rows were deleted.
> - **Known issue, not fixed here:** a fresh analysis took about 28 s in that run, because Gemini times out on each of the two calls before Groq answers. Fix on the configuration side (a Gemini model that responds, or make Groq the primary) or reduce `DISPUTE_AI_TIMEOUT_MS`. Seeded disputes are unaffected (instant).
> - **Race not covered live:** the double-click race is tested with a fake repository that mirrors the SQL (`WHERE analysis_computed_at IS NULL`); two simultaneous real requests would still both spend LLM budget before one of them loses.
> - **Deviation:** the design's step "`paypal.getDispute(id)` first" is not done inside `analyze`; the deadline refresh from PayPal happens in the read layer (M2-01), and analysis needs only the local dispute and its order's evidence.

---

### M2-04 · Approval records + action executions

- [x] `src/lib/disputes/approval.ts` — one function, `resolveApprovalState(disputeId, actionType)`, returns a discriminated union:
  - `{ kind: 'already_executed', execution }` — an approved record exists and its `action_executions.executed_at IS NOT NULL`
  - `{ kind: 'retry', approval, execution }` — an approved record exists with an **unexecuted** `action_executions` row
  - `{ kind: 'first' }` — no approved record
  - plus `createApprovalWithExecution(input)` (single transaction: insert approval + execution with fresh `paypal_request_id`)
- [x] `POST /api/disputes/[id]/approve` branches on `resolveApprovalState`:
  - **`already_executed`** → return "Action already executed"; **insert nothing**
  - **`retry`** → reuse the existing execution and its **same `PayPal-Request-Id`**; **insert nothing** (no new approval row, no new execution row); go straight to the execute step
  - **`first`** → `createApprovalWithExecution` (partial unique index still guards concurrent first approvals; a unique-violation is re-read and routed to `retry`/`already_executed`)
  - Execute step (retry + first): determine simulate vs. live (`DEMO_MODE || dispute.is_seed || dispute.is_demo`)
  - Simulate: `is_simulated = true`, `executed_at = now()`; Live: call PayPal → on fail: return error, leave `executed_at` null (the next click lands in the `retry` branch)
  - **If `action_type = 'accept_claim'` and execution succeeded (or simulated):** automatically set `disputes.outcome = 'refunded'`, `status = 'resolved_refunded'`; insert `dispute_outcomes`; increment `resolved_since_last_proposal`; run learning loop check
  - Log `merchant_action` and `paypal_api` (or `simulated`)
- [x] `POST /api/disputes/[id]/reject`: insert rejection record; log
- [x] Tests (`src/lib/disputes/__tests__/approve-branching.test.ts`, mocked DB + mocked PayPal):
  - **first**: no records → inserts exactly 1 approval + 1 execution; PayPal called once with the new `paypal_request_id`
  - **retry path**: approved record + unexecuted execution (previous PayPal call failed) → **inserts 0 rows**; PayPal called once with the **same `paypal_request_id`** as the stored row; on success `executed_at` is set
  - **retry then fail again** → still 0 inserts; `executed_at` stays null; same request id
  - **already_executed**: executed row → 0 inserts, PayPal **not** called, returns the already-executed result
  - **concurrent first approval** (unique violation on insert) → resolves to `retry` or `already_executed`, never a second execution row
  - **accept_claim success** → exactly one `dispute_outcomes` row (`refunded`) and one counter increment; the retry branch does not double-increment


> M2-04 notes (34 new tests in `approve-branching.test.ts`; 565 in total):
>
> - **`src/lib/disputes/approval.ts`**: `resolveApprovalState(repo, disputeId, actionType)` returns `already_executed` / `retry` / `first`, and `createApprovalWithExecution` inserts the approval and its execution in ONE transaction with a fresh `paypal_request_id`. An approval with no execution row fails loudly (data integrity) instead of creating a second approval.
> - **`src/lib/disputes/approve.ts`** (`approveDispute`, `rejectDispute`) and the routes `POST /api/disputes/[id]/approve` and `.../reject`. `already_executed` -> 200 "Action already executed", inserts nothing, sends nothing. `retry` -> reuses the stored execution and request id, inserts nothing, sends the STORED payload (a different draft in the retry request is ignored). `first` -> stores approval + execution, then executes. A unique violation on insert (concurrent first approval) is re-read and routed to `retry` or `already_executed`; a second execution row is never created. A live failure returns 502 `{ status: "execution_failed", retryable: true, message }` and leaves `executed_at` null.
> - **The action is derived from the recommendation, not chosen by the client:** contest -> `submit_evidence`, refund -> `accept_claim`. A request for the other action is 409 `wrong_action`. A dispute that is not open, not analysed, or has no usable draft/tracking is refused BEFORE anything is stored. An "edit" equal to the original (or blank) is not recorded as an edit; original and edited drafts are both stored. The payload hash is the SHA-256 of a key-sorted JSON of the action and payload.
> - **Reject** records a rejection (no execution, nothing sent, dispute stays open). Rejections are unconstrained and do not block a later approval; an already-approved action reports 409 `already_approved`.
> - **Learning loop:** `accept_claim` increments `resolved_since_last_proposal` (once, via the outcome row); the "run learning loop check" is M4 and is a hook (`onOutcomeRecorded`) that is not bound yet.
> - **Test list (all pass):** the six required cases (first; retry path; retry then fail again; already_executed; concurrent first approval resolving to retry or already_executed; accept_claim with one outcome row and one counter increment, no double increment on retry), plus simultaneous approvals, simulation on seeded/demo disputes and `DEMO_MODE`, edits/payload/hash, eight refusal cases that insert nothing and send nothing, reject, the state resolver, and the activity log.
> - **Verified live** (dev server, real Supabase, signed in, temporary demo disputes, all rows removed and the shared counter restored; `db:seed:verify` passes afterwards): 401 without a session; 400 for non-JSON, an unknown action, extra fields and a 2001-character edit; 404 for an unknown dispute and for another session's; 409 for the wrong action, with nothing stored; reject then approve with an edit: the execution row has `executed_at`, `is_simulated`, the original and edited drafts, a `PROOF_OF_FULFILLMENT` payload with the real tracking number and the EDITED notes, an approval row by `demo-merchant` with a 64-hex SHA-256, and a UUID request id; approving again is \"Action already executed\" with nothing inserted; rejecting after approval is 409; **five simultaneous approvals of a refund: all 200, one `executed` and four `already_executed`, exactly one approved record, one execution row, one `dispute_outcomes` row, counter +1**, and a sixth later approval does not move the counter; the activity log has the reject, approve and simulated `submit_evidence` rows with no draft text, tracking number or request id.
> - **Not verified:** the live-failure retry against a real PayPal outage (covered by the fake-PayPal tests and by the repo tests against the real database, but no real PayPal write has ever been sent); and the approve UI, which is M2-07.

---

### M2-05 · PayPal service layer — disputes (write)

- [x] `submitEvidence(disputeId, payload, approvalRecordId)`:
  - Verify the approval record (`decision = 'approved'`) and load the existing `action_executions` row created by the approve handler (this function never inserts one; it reuses its `paypal_request_id`)
  - `shouldSimulate = isDemoMode() || dispute.is_seed || dispute.is_demo`
  - Map `dispute.reason` to `evidence_type` via `buildProvideEvidencePayload(dispute, draft, documents)`:
    - `item_not_received` → `PROOF_OF_FULFILLMENT` with `evidence_info.tracking_info`
    - `not_as_described` → **`DECLARATION`** with `notes` (primary; the demo has no document upload); `PHOTOS_OF_SHIPPED_ITEM` **only when at least one document is attached** (never sent without `documents[]`)
  - Unit test the payload builder for all three branches
  - Live: `POST /v1/customer/disputes/{id}/provide-evidence` with `PayPal-Request-Id` header; on failure, return error (do not set `executed_at`)
  - Simulate: mark simulated, set `executed_at`
- [x] `acceptClaim(disputeId, note, approvalRecordId)`:
  - Same verify/load-execution and simulate vs. live logic; `POST /v1/customer/disputes/{id}/accept-claim` with `{ note, accept_claim_type: 'REFUND' }`


> M2-05 notes (53 new tests; 531 in total). **Built before M2-04**, because M2-04's tests exercise the real executor (see CHANGES.md).
>
> - **Payload builder** (`src/lib/paypal/evidence-payload.ts`, pure): `item_not_received` -> `PROOF_OF_FULFILLMENT` with the tracking info on file (carrier mapped to UPS/FEDEX/USPS/DHL, anything else `OTHER` + `carrier_name_other`; no tracking URL; `date` only if `shippedAt` parses); `not_as_described` -> **`DECLARATION`** with notes, and `PHOTOS_OF_SHIPPED_ITEM` **only when a document is attached**. A test walks every reason x documents x tracking combination and asserts PayPal's rejected pairings (proof of fulfillment on a NAD claim, photos with no document) cannot be produced. An INR claim with no usable tracking is refused (`missing_tracking`), not sent half-empty. Notes are trimmed, CRLF-normalised and limited to PayPal's 2000 characters (2000 ok, 2001 refused). The accept-claim note is fixed text.
> - **Live call** (`src/lib/paypal/dispute-writes.ts`): `POST /v1/customer/disputes/{id}/provide-evidence` and `/accept-claim`, id URL-encoded, with the **stored** `PayPal-Request-Id`. It is not exported from the PayPal index, and a structural test fails if anything but `src/lib/disputes/executor.ts` imports it.
> - **Executor** (`src/lib/disputes/executor.ts`): never inserts approvals or executions; takes the approval and the unexecuted execution, runs the action through `submitEvidence` / `acceptClaim` (the existing `requireApproval` gate), then simulates (`DEMO_MODE`, seed or demo dispute: no network call, `is_simulated`, `executed_at` set) or sends live. A PayPal failure (or missing credentials, or no PayPal dispute id) returns `failed` and marks nothing done, so the next click is a retry with the same request id. A non-PayPal error is rethrown, not disguised as retryable. A missing, rejected, other-action or other-dispute approval throws `ApprovalRequiredError` before any call or simulation.
> - **Consequences are one transaction** (`repo.completeExecution`): mark the execution done only if it is not already (`WHERE executed_at IS NULL`); `submit_evidence` -> dispute `action_taken`; `accept_claim` -> dispute `resolved_refunded` + outcome `refunded`, insert the `dispute_outcomes` row with `ON CONFLICT DO NOTHING`, and increment `resolved_since_last_proposal` only if that row was inserted. So a retry, or two simultaneous executions, can never count the refund twice (tested with a fake that mirrors the SQL AND against the real database).
> - **Learning loop:** after a refund outcome is recorded, an optional `onOutcomeRecorded` hook runs (errors swallowed). The check itself belongs to M4; it is not bound yet, so today only the counter moves.
> - **Verified against the real database** (8 live tests, temporary demo disputes, shared counter restored; `db:seed:verify` passes afterwards): a second APPROVED record for the same dispute and action is a genuine unique violation recognised as `ApprovalConflictError` (so the error-code mapping works through Drizzle's wrapping); 5 simultaneous first approvals give exactly 1 winner, 4 conflicts and exactly 1 execution row; rejections are unconstrained and do not block a later approval; completion sets `executed_at` once and a repeat is `applied: false`; an accept_claim completion gives one outcome row and one counter increment, and a retry changes nothing; a pre-existing outcome row means no second row and no counter change; an accept_claim completion without a snapshot rolls back entirely.
> - **Test timeout raised to 30 s** (`vitest.config.mts`) because several files now talk to the remote database in parallel; offline tests still finish in milliseconds.
> - **Not verified:** the live PayPal calls. The sandbox cannot be given a dispute from this app, so `provide-evidence` / `accept-claim` are exercised only against a mocked `fetch`. Open question for a real run: PayPal documents provide-evidence as `multipart/form-data` when documents are attached; the JSON body used here (no documents) is unconfirmed against the real endpoint.
> - **Deviation:** the task describes `submitEvidence(disputeId, payload, approvalRecordId)` loading the execution row itself. Here the approve handler passes the approval and execution it already holds to `executeApproved`, which hands the stored payload to the existing gate functions (unchanged signature); the invariant is the same (gate first, never insert, reuse the stored request id).

---

### M2-06 · Dispute inbox UI

- [x] Dispute inbox page (`/disputes`):
  - **Open tab** (default): table (reason, amount, `<DeadlineCountdown>`, order link, status, demo badge); default sort by deadline; skeleton + empty state
  - **Resolved tab**: table (reason, amount, outcome badge, resolved date, order link); sorted by resolved date descending; includes H1–H5 seed rows + any disputes resolved during the session
  - `<DeadlineCountdown deadline />` component — client-side live update; red < 48 h
  - Resolved disputes must not appear in the Open tab and vice versa


> M2-06 notes (4 new tests; 607 in total):
>
> - **`/disputes`** (`src/app/(app)/disputes/(list)/page.tsx`, server-rendered): Open tab (default) and Resolved tab (`?tab=resolved`; anything else falls back to Open). Open: reason (linked), amount, live `<DeadlineCountdown>`, order link, status, Demo data badge; sorted by deadline. Resolved: reason, amount, outcome badge (with \"simulated outcome\" when it was), resolved date, order link; newest first. A dispute is on exactly one tab (the read layer decides). Skeleton (`loading.tsx`, scoped to the list with a route group so a missing dispute still returns 404) and an empty state per tab. Less important columns hide on narrow screens.
> - **`<DeadlineCountdown>`** (client): the server renders the first value; the browser refreshes it every 30 s. Red under 48 hours (REQ-DIS-02), with a screen-reader \"urgent\" note.
> - **Shared look** (`src/lib/disputes/present.ts`, `src/components/tone-badge.tsx`): one colour language, green good, amber needs attention, red bad or urgent, and the text always says it too. The Disputes link in the sidebar is now live.
> - **Verified live** (dev server, real Supabase, signed in): signed-out redirect; tabs; the 3 open seeds each with a Demo data badge, ordered SEED-E (40 h), SEED-D (48 h), SEED-C (72 h); countdowns `1d 15h`, `1d 23h`, `2d 23h left`; SEED-E red, SEED-C not; no resolved dispute on Open; Resolved shows the 5 historical seeds with 2 Won, 1 Lost, 2 Refunded, newest first, no countdowns.
> - **Not verified:** a real browser (the live tick, layout at 375 px). The checks read server-rendered HTML. No `GET /api/disputes` route was added: the pages read through the same service the API would (design table lists it; nothing calls it yet).

---

### M2-07 · Dispute detail page (hero)

- [x] Auto-trigger `POST /api/disputes/[id]/analyze` on first load; loading state during analysis
- [x] `<RecommendationCard>`: badge (Contest / Refund), source tag, reasoning text
- [x] `<WinLikelihoodMeter>`: % bar, Strong/Moderate/Weak badge, source tag
- [x] Evidence used / gaps chips
- [x] `<ApprovalPanel>`: editable textarea (draft); Approve / Edit+Approve / Reject; idempotency notice; error + retry button on live write failure; `<SimulatedBadge>` in Demo Mode
- [x] LLM fallback state: system recommendation shown, no win likelihood meter, fallback note


> M2-07 notes (15 new tests; 622 in total):
>
> - **`/disputes/[id]`** (`src/app/(app)/disputes/[id]/page.tsx`, data from `src/lib/disputes/detail.ts`): header with reason, amount, live countdown (or the outcome for a resolved dispute), status, Demo data badge, order link and the buyer's message (rendered as plain text). Then `<RecommendationCard>`, `<WinLikelihoodMeter>`, `<EvidenceChips>` and `<ApprovalPanel>` (`src/components/disputes/`).
> - **Auto-trigger:** only a dispute with NO stored analysis renders `<AnalysisTrigger>`, which calls `POST /analyze` once (guarded against React's double effect in dev), shows a skeleton, waits on a `202 in_progress`, then refreshes. A dispute that is already analysed, which includes every seed, renders its stored analysis on the server and makes no request at all.
> - **RecommendationCard:** Contest / Refund badge, the source tag \"System recommendation\" or \"AI-adjusted recommendation\", the reasoning, and when the AI overrode the system, which way and why. **Fallback state:** \"AI unavailable \u2014 showing rule-based result.\" and no meter.
> - **WinLikelihoodMeter:** \"Estimated win likelihood\", the percentage, Strong / Moderate / Weak in green / amber / red, a bar with `role=\"meter\"` and aria values, and \"System estimate\" or \"AI-adjusted estimate\" with the points moved.
> - **ApprovalPanel:** the editable draft (read-only until **Edit**; \"Approve edited response\" when changed; a character count against PayPal's 2000), **Approve**, **Reject**; refunds have no draft and \"Approve refund\". A live (non-simulated) action asks for a confirmation first. States: decide (with \"you rejected this on ...\" if so), retry (explains it is safe, same request), done (\"Action already executed\", with the Simulated badge when simulated), resolved. Errors show PayPal's safe message and a Retry button. The server re-checks everything; the panel is only a front end.
> - **Verified live** (dev server, real Supabase, signed in): SEED-C (95% Strong, Contest, draft textarea, Approve / Edit / Reject, `role=\"meter\"` with `aria-valuenow=\"95\"`), SEED-D (27% Weak, Refund, no textarea, \"Approve refund\"), SEED-E (44% Moderate, Contest, red countdown) all render with the stored analysis, the System recommendation tag, the Demo data and simulated notice and the evidence chips, and **opening all three spent no LLM budget and wrote no `llm_call` rows**; resolved H3 shows Lost and no approve buttons; unknown and malformed ids are 404. With temporary rows: an unanalysed dispute renders the analysing state and rendering it does not analyse; an AI-fallback dispute shows the note and no meter; an AI-adjusted one shows the tag, the override and \"-10 pts\"; a retry state shows Retry; after a real API approval the page shows \"Action already executed\" with the Simulated badge.
> - **Not verified:** clicking in a real browser (the auto-trigger POST, Edit, the confirmation step, router refresh after approve). The client logic is exercised only through the same API calls made by script.

---

### M2-08 · Dispute timeline

- [x] `<DisputeTimeline events />`: 6 steps (dispute created → evidence assembled → analysis completed → draft created → merchant decision → action executed); timestamps, status, simulated labels
- [x] Wire to dispute detail; derive events from DB timestamps


> M2-08 notes (14 new tests; 636 in total; `npm run build` passes):
>
> - **`buildTimeline`** (`src/lib/disputes/timeline.ts`, pure) and **`<DisputeTimeline>`** (`src/components/disputes/dispute-timeline.tsx`): the six steps in order, Dispute created, Evidence assembled, AI analysis completed, Draft created, Merchant decision, PayPal action executed. Each is done / not yet / skipped / failed, with a timestamp taken only from the database (dispute `created_at`, the newest evidence artefact, `analysis_computed_at`, the latest approval or rejection, the execution's `executed_at`, or the resolution date for historical seeds) and the Simulated badge on a simulated action or outcome. Covers: refund (draft skipped), AI unavailable, approved with edits, rejected (action skipped), rejected-then-approved, a failed PayPal call (failed, with Retry advice), simulated refund, and historical resolved disputes (decision skipped, resolved at the resolution date).
> - **Wired** into the detail page beside the decision panel (and under the analysing state when there is no analysis yet), refreshed after every approve or reject.
> - **Verified live** (dev server, real Supabase, signed in): SEED-C, SEED-D and SEED-E each show all six steps; after a real API approval of a temporary demo dispute the timeline shows \"Approved the response.\" and \"Simulated: evidence submitted.\" with timestamps; the retry state shows the failed step; an unanalysed dispute shows \"Not analysed yet.\"; an AI-fallback one says the AI step was unavailable. Temporary rows removed; `db:seed:verify` passes.
> - **Not verified:** the timeline in a real browser.

---

## Milestone 3 — Evidence Vault + Full Dispute Flow
**Demo-able after:** Mark order shipped → vault populated → simulate dispute → full approval flow.

---

### M3-01 · Tracking API integration

- [ ] Research and select a free carrier tracking API (AfterShip free tier or TrackingMore)
- [ ] `src/lib/tracking/client.ts`: `getTrackingEvents(trackingNumber, carrier)` with Demo Mode fallback (returns mocked seed events with `isMocked: true`)
- [ ] Zod-validated `TrackingEvent` response schema

---

### M3-02 · Evidence assembler

- [ ] `src/lib/evidence/assembler.ts`:
  - `assembleEvidence(orderId, paypalOrder, trackingInput)` — inserts artefact rows (append-only; no UPDATE)
  - `getEvidenceByOrderId(orderId)` — fetch all artefacts
- [ ] Note: `computeEvidenceCompleteness` is already in `src/lib/scoring/` from M1-04; assembler imports it from there

---

### M3-03 · Ship order API + evidence endpoints

- [ ] `POST /api/orders/[id]/ship` — validate status = captured;
  - **For non-seed, non-demo orders (and `DEMO_MODE=false`):** call `paypal.addTracking(paypal_order_id, { capture_id: order.paypal_capture_id, tracking_number, carrier, notify_payer: false })` first. On failure, log `error`, return a non-blocking warning, and continue. For seed/demo orders skip the call and log `simulated`.
  - then `paypal.getOrder`; `trackingApi.getTrackingEvents`; `assembleEvidence`; `computeEvidenceCompleteness`; update order; log
- [ ] `GET /api/orders/[id]/evidence` — artefacts + completeness score
- [ ] `POST /api/orders/[id]/evidence/communication` — append buyer communication artefact

---

### M3-04 · Evidence Vault UI

- [ ] `<EvidenceCompleteness score artefacts />`: progress ring; artefact checklist (shows split tracking sub-criteria separately); "mocked" badge on mocked events; expandable payloads
- [ ] Evidence vault section on order detail
- [ ] "Mark as Shipped" button + modal (tracking number + carrier)
- [ ] "Simulate dispute" button on shipped order detail (Demo Mode only) → `POST /api/disputes/simulate`

---

### M3-05 · Agent Activity log

- [ ] `GET /api/activity` — paginated (pageSize=20); `?refOrderId` / `?refDisputeId` filters
- [ ] Activity full page (`/activity`): reverse-chrono; 5 s polling; filter bar; expandable rows; `<SimulatedBadge>`
- [ ] `<ActivityFeed entries limit />` component
- [ ] Wire to order detail (filtered) and dispute detail (filtered)

---

### M3-06 · Simulate dispute + simulate outcome

- [ ] `POST /api/disputes/simulate` — body `{ orderId }`; creates synthetic dispute (`is_demo = true`, `deadline_offset_hours = 72`); order must be shipped
- [ ] `POST /api/disputes/[id]/simulate-outcome` — body `{ outcome: 'won' | 'lost' }`:
  - Only available when `action_type = 'submit_evidence'` has been executed/simulated (contest path)
  - Only allowed when `is_demo = true` and action executed/simulated
  - Updates dispute; inserts to `dispute_outcomes`; increments `resolved_since_last_proposal`
  - **Not** available after `accept_claim` (refund outcome is auto-recorded in M2-04)
- [ ] "Simulate outcome (Won / Lost)" UI control: shown only after `submit_evidence` action; `<SimulatedBadge>` on simulated outcomes in timeline and dispute list

---

### M3-07 · (Stretch) Read-only PayPal Agent Toolkit for evidence gathering

Only if M3-01 to M3-06 are done and time remains. Skip without affecting the demo.

- [ ] Add `@paypal/agent-toolkit` (pinned exact version); confirm its available tool names from the installed package
- [ ] `src/lib/ai/agent-tools.ts`: hard-coded **read-only allowlist** (fetch order / transaction / shipment details only). Anything else is never sent to the LLM provider. **No write tool (create, capture, refund, submit, accept) is ever exposed to the LLM.**
- [ ] Wire into `analyseDispute` as an optional tool-use loop: max 3 tool calls; results placed in the `<data>` section as untrusted; each call logged as `paypal_api`; budget-gated via `checkLlmBudget`
- [ ] Skipped for seeded disputes and on any toolkit error (analysis continues with local evidence)
- [ ] Unit test: the tool list handed to the LLM provider equals the allowlist exactly; a test asserts no allowlisted name matches `create|capture|refund|submit|accept|update|delete`

---

## Milestone 4 — Learning Loop, Dashboard, Polish, Deploy
**Demo-able after:** Full end-to-end demo; all pages complete; live on Vercel + Supabase.

---

### M4-01 · Learning loop

- [ ] `src/lib/ai/insights.ts`:
  - `proposeWeightChanges(outcomes, currentWeights)` — `tool_choice: { type: 'tool', name: 'weight_proposal' }`; ±3 cap; [5,30] clamp; fallback = unchanged weights with note
  - `generateInsightsSummary(outcomes, weights, proposed)` — `tool_choice: { type: 'tool', name: 'insights_summary' }`
- [ ] Add `weight_proposal`, `insights_summary` tool definitions to `src/lib/ai/tools.ts`
- [ ] Trigger on `dispute_outcomes` insert:
  - Increment `resolved_since_last_proposal`
  - If `resolved_since_last_proposal % 5 = 0`:
    - **If** `proposal_created_at IS NOT NULL` (proposal already pending): log `rule_engine` step `"proposal_skipped_pending"`; do **not** call LLM; do **not** reset counter
    - **Else**: call `proposeWeightChanges`; store proposal; reset `resolved_since_last_proposal = 0`

---

### M4-02 · Insights API

- [ ] `GET /api/insights`: weights + deltas + pending proposal + outcome breakdown + **cached** AI summary from `insights_cache` (`usedFallback`). **This route never calls the LLM.** If the cache row is missing, return a rule-based summary (counts + current weights) with the "AI unavailable" note.
- [ ] `regenerateInsightsSummaryIfStale()` in `src/lib/ai/insights.ts`: compute `sha256(outcomeCount + latestOutcomeId + proposal_created_at + activeWeights)`; if it equals `insights_cache.input_fingerprint` do nothing; otherwise call `generateInsightsSummary` (via `callWithFallback`, budget-gated) and upsert `insights_cache`
- [ ] Call `regenerateInsightsSummaryIfStale()` from the write paths only: dispute outcome insert, proposal creation, approve-weights, reject-weights, reset-demo
- [ ] Seed `insights_cache` with a deterministic summary (`used_fallback = false`) so Insights loads populated with zero LLM calls
- [ ] Test: two consecutive `GET /api/insights` make 0 LLM calls; an outcome insert followed by regenerate makes exactly 1; an unchanged fingerprint makes 0
- [ ] `POST /api/insights/approve-weights`: move proposed → active; clear proposed; log `merchant_action`
- [ ] `POST /api/insights/reject-weights`: clear proposed; log `merchant_action`

---

### M4-03 · Insights page UI

- [ ] Signal weights table: name, current, baseline, delta (coloured ↑↓)
- [ ] `<WeightChangeProposal>` card: proposed deltas, LLM reasoning, Approve / Reject
- [ ] Outcome breakdown bar chart + AI summary card (fallback note when `usedFallback`)
- [ ] Loading skeleton; empty state

---

### M4-04 · Dashboard metrics

- [ ] `GET /api/dashboard`:
  - `value_under_review`: SUM(amount_usd) WHERE verdict='hold'
  - `disputes_won`: count + SUM(disputed_amount_usd) WHERE outcome='won'
  - `chargeback_fees_avoided`: count WHERE outcome='refunded' × `CHARGEBACK_FEE_USD`
  - `dollars_protected`: SUM(disputed_amount_usd) WHERE outcome='won'
  - `dollars_protected_simulated`: SUM(disputed_amount_usd) WHERE outcome='won' AND outcome_is_simulated=true
  - `recent_activity`: last 5 `agent_activity` rows
  - `verdict_distribution`: count by verdict
- [ ] Dashboard page (`/`):
  - 4 metric cards; "Dollars protected" card shows sub-label "$X from simulated outcomes" when `dollars_protected_simulated > 0`
  - Risk distribution donut chart
  - Recent activity feed
  - "Reset demo" button (confirmation dialog: "This resets data for all judges") + success toast

---

### M4-05 · Reset demo

- [ ] `POST /api/demo/reset`: Postgres transaction —
  1. DELETE non-seed rows from: `agent_activity`, `action_executions`, `approval_records`, `dispute_outcomes`, `evidence_artefacts`, `disputes`, `orders` (WHERE `is_seed = false`)
  2. Reset `signal_weights`: restore defaults + recreate pending proposal (`proposed_*` set, `proposal_created_at` set); `resolved_since_last_proposal = 0`
  3. Re-insert all seed records (upsert by seed ID): SEED-A/B/D-ORD/E-ORD/F orders, H1-ORD through H5-ORD, SEED-C/D/E open disputes (status=open, no approval/execution rows), H1–H5 resolved disputes with `dispute_outcomes` rows
  4. Re-insert pre-computed analysis for SEED-C/D/E (set `analysis_computed_at`)
  5. Restore the seeded `insights_cache` row (deterministic summary, matching fingerprint) so Insights makes no LLM call after a reset. Do **not** clear `llm_daily_usage` (the global cap must survive resets) or `llm_rate_limits`
- [ ] Wire button; success toast; full page refresh

---

### M4-06 · Polish — loading, empty states, errors

- [ ] Loading skeletons for all pages and major sections
- [ ] Empty states with meaningful messages for all list views
- [ ] Error boundaries: section-level error cards with retry buttons
- [ ] `<Toaster />` for: approval submitted, write error, reset complete, analysis triggered

---

### M4-07 · Polish — responsive layout

- [ ] Fix all pages at 375 px mobile (sidebar → hamburger/bottom nav)
- [ ] Fix all pages at 1280 px desktop
- [ ] Dispute detail hero fully usable on mobile

---

### M4-08 · Final Vercel + Supabase deploy

- [ ] Re-migrate and re-seed production Supabase after M4 schema is finalised
- [ ] Set all final env vars in Vercel; deploy
- [ ] Add `vercel.json` with keep-alive cron: `{ "crons": [{ "path": "/api/demo/status", "schedule": "0 12 */3 * *" }] }` (pings every 3 days to prevent cold-start spin-down)
- [ ] Smoke-test all pages with seed data on production URL
- [ ] Verify simulated badge, demo badge, and retry flow on production

---

### M4-08b · Verify LLM budget guard in production

The guard itself is built in M1-09b. This task verifies it end to end.

- [ ] Set `LLM_DAILY_CAP=3` on a preview deployment; trigger 4 LLM calls on non-seed data → the 4th returns the rule-based result with the "AI unavailable" note, **no 429**, and an `llm_budget_exceeded` row appears in Agent Activity
- [ ] Confirm seeded disputes and the Insights page still load fully with the cap exhausted (they make no LLM calls)
- [ ] Confirm an unauthenticated `curl` to any `/api/*` route returns 401 except `/api/demo/status`
- [ ] Confirm the keep-alive cron hits `/api/demo/status` and the response includes `db: 'ok'`
- [ ] Restore `LLM_DAILY_CAP=200`

---

### M4-09 · Final QA checklist

- [ ] `npm run test` — all unit tests pass
- [ ] Full demo script:
  1. Log in with demo credentials
  2. Orders list: SEED-B amber/Verify first/55; SEED-F red/Hold/70
  3. SEED-B detail: AI explanation, verification draft, 3 active signals (country mismatch, first-time high value, rush shipping)
  4. SEED-F detail: 4 active signals; $320 > $255 threshold shown
  5. Dispute inbox (Open tab): SEED-C, SEED-D, SEED-E visible; sorted by deadline
  6. Dispute inbox (Resolved tab): H1–H5 visible with Won/Lost/Refunded outcome badges
  7. Open SEED-C dispute: win likelihood **95%** / Strong, Contest, "System recommendation"; full evidence vault, Delivered scan
  8. Approve SEED-C contest → "simulated" badge on execution
  9. Simulate outcome Won on SEED-C → SEED-C moves to Resolved tab; dashboard Dollars protected updates
  10. Open SEED-D dispute: win likelihood **27%** / Weak, Refund recommendation; approve accept_claim → outcome auto-records as Refunded; SEED-D moves to Resolved tab; no simulate outcome control appears
  11. Open SEED-E dispute: win likelihood **44%** / Moderate, Contest; evidence gaps shown, In Transit tracking, red countdown (< 48 h)
  12. Insights page: pending weight proposal visible; H1–H5 outcomes in breakdown; approve proposal → weights update
  13. Dashboard: Dollars protected > 0 with simulated sub-label; Value under review = $320 (SEED-F)
  14. Reset demo: SEED-C/D/E back in open inbox; H1–H5 in Resolved; proposal recreated; Dollars protected reset
- [ ] "Demo data" badges on all seed-data components
- [ ] Double-execution blocked: open SEED-C after approval → "Action already executed" notice; no second action execution row created
- [ ] LLM fallback: leave `LLM_API_KEY` empty, then set it to an invalid key → "AI unavailable" notes appear; system recommendation shown. With a valid primary and an invalid `LLM_FALLBACK_API_KEY` (and vice versa) the app still works
- [ ] Live write error: with `DEMO_MODE=false` on a real (non-seed) dispute → error surfaces; retry button appears; same `PayPal-Request-Id` reused on retry

---

## Milestone 5 — Submission Assets
**Demo-able after:** All assets prepared; submission-ready.

---

### M5-01 · README

- [ ] Write `README.md`:
  - Project name, tagline, short description (2–3 sentences)
  - Live demo URL (Vercel)
  - Public demo credentials (email + password) prominently displayed
  - **Free-tier note: keep `LLM_DAILY_CAP` under your provider's daily request limit (check it in the provider's console, e.g. Google AI Studio for Gemini). When a provider returns 429 the app tries the optional fallback provider once, then uses its rule-based results. If a paid key is used instead, set a spend limit in that provider's console.**
  - All env vars table with types, defaults, descriptions
  - One-command local dev setup
  - Architecture overview (stack, data flow, 3–4 sentences)
  - Link to Devpost submission
  - Screenshots (inline markdown images)

---

### M5-02 · Screenshots

- [ ] Capture production screenshots of: Dashboard, Orders list, Order detail (SEED-B with signals), Dispute detail (SEED-C contest with win likelihood meter), Dispute detail (SEED-E with evidence gaps), Insights page (pending proposal), Agent Activity log
- [ ] Optimise images (WebP, ≤ 300 KB each); store in `/public/screenshots/`
- [ ] Embed in README

---

### M5-03 · Demo video

- [ ] Record a 2–3 minute walkthrough video following the M4-09 demo script
- [ ] Captions or narration covering: risk score explainability, AI verdict with source label, approve/reject flow, simulated outcome, learning loop
- [ ] Upload to YouTube (unlisted) or Loom; add link to README and Devpost

---

### M5-04 · Backup walkthrough video

- [ ] Record a separate 5–7 minute technical deep-dive video: code walkthrough of EV rule, base_win_probability rubric, tool-use pattern, approval invariant
- [ ] Keep as backup in case live demo fails during judging

---

### M5-05 · Devpost write-up

- [ ] Write Devpost submission:
  - Inspiration: micro-merchant chargeback pain
  - What it does: 3-sentence summary of the 5 core features
  - How it works: EV rule, rubric, tool-use pattern, approval invariant, learning loop
  - Challenges: PayPal API surface limitations (no list endpoint, provide-evidence payload quirks), shared demo DB strategy
  - Accomplishments: seed verification, zod-gated LLM outputs, idempotency design
  - What's next: per-session DB isolation, more dispute reason types, real tracking API
  - Tech stack bullet list
  - Screenshots (reuse from M5-02)
  - Demo video link

---

## Test File Locations

```
src/
  lib/
    scoring/
      __tests__/
        signals.test.ts              (M1-05: signal tests + seed score assertions)
        evidence-completeness.test.ts (M1-05: completeness scoring)
        win-probability.test.ts       (M1-05: base_win_probability seed assertions)
        recommendation.test.ts        (M1-05: EV rule tests)
    paypal/
      __tests__/
        invariant.test.ts             (M1-06: no-write-without-approval)
```
