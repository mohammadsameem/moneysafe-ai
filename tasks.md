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

- [ ] `POST /api/orders` → `paypal.createOrder` with `intent: CAPTURE`, `return_url` = `/api/orders/paypal-return`, `cancel_url` = `/api/orders/paypal-cancel`; insert order as `status = created` with `paypal_order_id`; return `{ orderId, approvalUrl }`
- [ ] "New sandbox order" UI on the Orders page: small form (item, amount, shipping method, billing/shipping country) → redirects to `approvalUrl`
- [ ] `GET /api/orders/paypal-return?token=…`: look up order by `paypal_order_id`, verify `session_id` matches caller, `paypal.captureOrder` → store `paypal_capture_id` and `status = captured` → ingest + score (settings baseline, active weights) → AI explanation via `callWithFallback` → redirect to `/orders/[id]`
- [ ] `GET /api/orders/paypal-cancel?token=…`: set `status = cancelled`, redirect to `/orders`
- [ ] `paypal.addTracking(paypalOrderId, { capture_id, tracking_number, carrier, notify_payer: false })` implemented against `POST /v2/checkout/orders/{id}/track` (called from the ship route in M3-03). **Confirm the exact path and payload against a real sandbox response** while building this task; adjust `types.ts` if the response differs.
- [ ] Verify against the real sandbox with `DEMO_MODE=false`: create → approve → return → captured → scored. If the sandbox is unreachable, order creation falls back to a seeded record badged "Demo data" (REQ-DEMO-01).
- [ ] Cookie config: session cookie `SameSite=Lax` so it survives the PayPal redirect

---

### M1-08 · Agent Activity logger

- [ ] `src/lib/activity/logger.ts`:
  - `logActivity(meta: ActivityMeta): Promise<void>` — inserts to `agent_activity`
  - PII scrub: replace email local-part with `***`
- [ ] Export `ActivityMeta` type

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

- [ ] `src/lib/ai/tools.ts`: tool definitions for `risk_explanation` and `verification_draft` (name, description, JSON-schema `parameters` kept in step with the zod schemas)
- [ ] `src/lib/ai/schemas.ts`: `RiskExplanationSchema`, `VerificationDraftSchema`
- [ ] `src/lib/ai/prompts.ts`: `buildRiskPrompt(order, signals)`, `buildVerificationPrompt(order)` with `<instructions>` / `<data>` separation
- [ ] `src/lib/ai/risk-explainer.ts`:
  - `explainRisk(...)` — `callWithFallback((ctx) => callStructured({ providers: getConfiguredProviders(), tool: risk_explanation, schema, prompt, onAttempt: ctx.onAttempt }).then(r => r.data), ruleBasedExplanation, meta, deps)`
  - `draftVerification(...)` — same pattern with the `verification_draft` tool and the static template as the fallback
- [ ] Bind the real `LlmDeps`: `logActivity` from M1-08, `checkBudget` from M1-09b, `isConfigured = () => getConfiguredProviders().length > 0`

---

### M1-09b · LLM budget guard + API session protection

- [ ] `src/lib/ai/rate-limit.ts`: `checkLlmBudget(sessionId): Promise<{ allowed: boolean; reason?: 'session' | 'daily' }>`
  - Per-session: 10 calls per rolling hour (`llm_rate_limits`; reset when `now() > window_start + 1h`)
  - Global daily cap: `LLM_DAILY_CAP` env (default **200**) against `llm_daily_usage` for the current UTC day
  - Increment both counters atomically in one transaction; only increment when allowed
- [ ] `callWithFallback` calls `checkLlmBudget` first (the gate itself is already implemented in `call-with-fallback.ts` against an injected `checkBudget`; this task supplies the real `checkLlmBudget` and binds it). On breach: skip the LLM call, return the rule-based fallback with `usedFallback = true`, log `agent_activity` with `tool_name = 'llm_budget_exceeded'`, `status = 'fallback'`, and `input_summary` naming the limit. **No HTTP 429 anywhere.**
- [ ] UI shows the visible note "AI unavailable — showing rule-based result." wherever `usedFallback` is true
- [ ] `src/middleware.ts`: require a valid NextAuth session on every `/api/*` route **except** `/api/demo/status` and `/api/auth/*`; unauthenticated API calls return 401 JSON
- [x] Add `LLM_DAILY_CAP` to `src/lib/env.ts` and `.env.example` (default 200; verified by `providers.test.ts`)
- [ ] Unit tests (`src/lib/ai/__tests__/rate-limit.test.ts`): allowed under both limits; session breach → `{ allowed:false, reason:'session' }`; daily breach → `reason:'daily'`; counters not incremented on breach; session window resets after 1 hour; `callWithFallback` returns the fallback (no LLM call) on breach (this last case is already covered in `call-with-fallback.test.ts` with a fake `checkBudget`)

---

### M1-10 · Orders API routes

- [ ] `GET /api/orders` — list from DB; include `riskScore`, `verdict`, `isDemo` in response
- [ ] `GET /api/orders/[id]` and the PayPal return handler (M1-07b) score via `settings.merchant_avg_order_value_usd`; order creation itself is M1-07b
- [ ] `GET /api/orders/[id]` — detail including signal breakdown, AI explanation, `usedFallback`

---

### M1-11 · Orders UI

- [ ] App layout: sidebar nav (all pages); MoneySafe AI logo + tagline "The risk desk for micro-merchants."
- [ ] Login page (`/login`): NextAuth credentials provider against `DEMO_PASSWORD`
- [ ] Dashboard placeholder (`/`) with "Coming in M4"
- [ ] Orders list page (`/orders`): table (ID, buyer, amount, date, risk badge, verdict, demo badge); sortable; skeleton + empty state
- [ ] `<RiskBadge verdict score />`, `<DemoBadge />`, `<SimulatedBadge />` components
- [ ] Order detail page (`/orders/[id]`): summary, score display, signal breakdown table, AI explanation card, verification draft card (verify-first only), demo badge

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

- [ ] `listDisputes()`: `GET /v1/customer/disputes` with Demo Mode fallback + zod validation
- [ ] `getDispute(id)`: `GET /v1/customer/disputes/{id}` with Demo Mode fallback + zod validation

---

### M2-02 · Dispute analysis engine

- [ ] `src/lib/ai/schemas.ts` additions: `DisputeAnalysisSchema`, `DraftResponseSchema`
- [ ] `src/lib/ai/tools.ts` additions: `dispute_analysis`, `dispute_draft_response` tool definitions
- [ ] `src/lib/ai/prompts.ts` additions: `buildDisputeAnalysisPrompt` (includes `base_win_probability` and `system_recommendation` in `<data>`), `buildDraftResponsePrompt`
- [ ] `src/lib/ai/dispute-analyst.ts`:
  - `analyseDispute(dispute, artefacts, base, systemRec)` — `tool_choice: { type: 'tool', name: 'dispute_analysis' }`; clamps `llm_adjustment`; computes `win_probability`, label, `final_recommendation`, `recommendation_source`
  - `draftDisputeResponse(dispute, artefacts)` — `tool_choice: { type: 'tool', name: 'dispute_draft_response' }`
  - Both use `callWithFallback`

---

### M2-03 · Dispute analysis API

- [ ] `POST /api/disputes/[id]/analyze`:
  - Guard: return cached if `analysis_computed_at IS NOT NULL`
  - Fetch dispute (PayPal or Demo); fetch artefacts from DB
  - `completeness = computeEvidenceCompleteness(artefacts)` (pure fn from M1-04)
  - `base = computeBaseWinProbability(completeness, artefacts, dispute.reason)`
  - Read settings → `systemRec = computeSystemRecommendation(amount, base, fee, effort)`
  - `ai.disputeAnalyst.analyseDispute(...)` — clamp, compute final fields
  - If `final_recommendation = 'contest'`: `ai.disputeAnalyst.draftDisputeResponse(...)`
  - Write all fields; set `analysis_computed_at`; log all steps

---

### M2-04 · Approval records + action executions

- [ ] `src/lib/disputes/approval.ts` — one function, `resolveApprovalState(disputeId, actionType)`, returns a discriminated union:
  - `{ kind: 'already_executed', execution }` — an approved record exists and its `action_executions.executed_at IS NOT NULL`
  - `{ kind: 'retry', approval, execution }` — an approved record exists with an **unexecuted** `action_executions` row
  - `{ kind: 'first' }` — no approved record
  - plus `createApprovalWithExecution(input)` (single transaction: insert approval + execution with fresh `paypal_request_id`)
- [ ] `POST /api/disputes/[id]/approve` branches on `resolveApprovalState`:
  - **`already_executed`** → return "Action already executed"; **insert nothing**
  - **`retry`** → reuse the existing execution and its **same `PayPal-Request-Id`**; **insert nothing** (no new approval row, no new execution row); go straight to the execute step
  - **`first`** → `createApprovalWithExecution` (partial unique index still guards concurrent first approvals; a unique-violation is re-read and routed to `retry`/`already_executed`)
  - Execute step (retry + first): determine simulate vs. live (`DEMO_MODE || dispute.is_seed || dispute.is_demo`)
  - Simulate: `is_simulated = true`, `executed_at = now()`; Live: call PayPal → on fail: return error, leave `executed_at` null (the next click lands in the `retry` branch)
  - **If `action_type = 'accept_claim'` and execution succeeded (or simulated):** automatically set `disputes.outcome = 'refunded'`, `status = 'resolved_refunded'`; insert `dispute_outcomes`; increment `resolved_since_last_proposal`; run learning loop check
  - Log `merchant_action` and `paypal_api` (or `simulated`)
- [ ] `POST /api/disputes/[id]/reject`: insert rejection record; log
- [ ] Tests (`src/lib/disputes/__tests__/approve-branching.test.ts`, mocked DB + mocked PayPal):
  - **first**: no records → inserts exactly 1 approval + 1 execution; PayPal called once with the new `paypal_request_id`
  - **retry path**: approved record + unexecuted execution (previous PayPal call failed) → **inserts 0 rows**; PayPal called once with the **same `paypal_request_id`** as the stored row; on success `executed_at` is set
  - **retry then fail again** → still 0 inserts; `executed_at` stays null; same request id
  - **already_executed**: executed row → 0 inserts, PayPal **not** called, returns the already-executed result
  - **concurrent first approval** (unique violation on insert) → resolves to `retry` or `already_executed`, never a second execution row
  - **accept_claim success** → exactly one `dispute_outcomes` row (`refunded`) and one counter increment; the retry branch does not double-increment

---

### M2-05 · PayPal service layer — disputes (write)

- [ ] `submitEvidence(disputeId, payload, approvalRecordId)`:
  - Verify the approval record (`decision = 'approved'`) and load the existing `action_executions` row created by the approve handler (this function never inserts one; it reuses its `paypal_request_id`)
  - `shouldSimulate = isDemoMode() || dispute.is_seed || dispute.is_demo`
  - Map `dispute.reason` to `evidence_type` via `buildProvideEvidencePayload(dispute, draft, documents)`:
    - `item_not_received` → `PROOF_OF_FULFILLMENT` with `evidence_info.tracking_info`
    - `not_as_described` → **`DECLARATION`** with `notes` (primary; the demo has no document upload); `PHOTOS_OF_SHIPPED_ITEM` **only when at least one document is attached** (never sent without `documents[]`)
  - Unit test the payload builder for all three branches
  - Live: `POST /v1/customer/disputes/{id}/provide-evidence` with `PayPal-Request-Id` header; on failure, return error (do not set `executed_at`)
  - Simulate: mark simulated, set `executed_at`
- [ ] `acceptClaim(disputeId, note, approvalRecordId)`:
  - Same verify/load-execution and simulate vs. live logic; `POST /v1/customer/disputes/{id}/accept-claim` with `{ note, accept_claim_type: 'REFUND' }`

---

### M2-06 · Dispute inbox UI

- [ ] Dispute inbox page (`/disputes`):
  - **Open tab** (default): table (reason, amount, `<DeadlineCountdown>`, order link, status, demo badge); default sort by deadline; skeleton + empty state
  - **Resolved tab**: table (reason, amount, outcome badge, resolved date, order link); sorted by resolved date descending; includes H1–H5 seed rows + any disputes resolved during the session
  - `<DeadlineCountdown deadline />` component — client-side live update; red < 48 h
  - Resolved disputes must not appear in the Open tab and vice versa

---

### M2-07 · Dispute detail page (hero)

- [ ] Auto-trigger `POST /api/disputes/[id]/analyze` on first load; loading state during analysis
- [ ] `<RecommendationCard>`: badge (Contest / Refund), source tag, reasoning text
- [ ] `<WinLikelihoodMeter>`: % bar, Strong/Moderate/Weak badge, source tag
- [ ] Evidence used / gaps chips
- [ ] `<ApprovalPanel>`: editable textarea (draft); Approve / Edit+Approve / Reject; idempotency notice; error + retry button on live write failure; `<SimulatedBadge>` in Demo Mode
- [ ] LLM fallback state: system recommendation shown, no win likelihood meter, fallback note

---

### M2-08 · Dispute timeline

- [ ] `<DisputeTimeline events />`: 6 steps (dispute created → evidence assembled → analysis completed → draft created → merchant decision → action executed); timestamps, status, simulated labels
- [ ] Wire to dispute detail; derive events from DB timestamps

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
