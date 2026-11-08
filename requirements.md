# MoneySafe AI — Requirements

> **Tagline:** The risk desk for micro-merchants.  
> PayPal AI Hackathon submission  
> Version 1.7 | Single-merchant demo scope

---

## 1. Glossary

| Term | Definition |
|---|---|
| Merchant | The single demo user operating the MoneySafe AI dashboard |
| Order | A PayPal transaction created/captured via the Orders v2 API (sandbox) or seeded locally; the app owns and persists the orders table |
| Risk Score | A deterministic 0–100 score (clamped, never exceeds 100) derived from weighted rule signals |
| Verdict | Ship / Verify first / Hold — the actionable recommendation derived from the risk score |
| Evidence Vault | Structured record of all artefacts attached to a shipped order |
| Dispute | A PayPal buyer complaint that may escalate to a chargeback |
| Agent Activity | Persistent log of every LLM and PayPal API call made by the system |
| Demo Mode | Fallback mode where seeded realistic data is returned instead of live sandbox data |
| Approval Record | Immutable row in `approval_records` capturing who approved a money-moving action and when |
| Action Execution | Immutable row in `action_executions` recording the actual PayPal call that followed an approval |
| Value under review | Total value of orders with verdict = Hold; represents risk exposure, not a confirmed outcome |
| Dollars protected | Confirmed outcome value only: total value of disputes won via the contest path |
| Chargeback fee avoided | Estimated fee saved when the merchant accepts a proactive refund: count of accepted-refund disputes × `CHARGEBACK_FEE_USD` |
| Untrusted input | Any content originating outside the system: buyer messages, dispute reason text, order descriptions |

---

## 2. Scope

**In scope**
- App-owned orders table; orders created/captured via PayPal Orders v2 (sandbox) or seeded locally with full metadata
- Risk scoring with explainable signals; fixed seeded merchant baseline average order value ($85 from `settings` row; not recomputed from live orders)
- `CHARGEBACK_FEE_USD` and `CONTEST_EFFORT_USD` read from environment variables only (not stored in `settings`)
- Evidence assembly and storage on shipment; tracking events from a free tracking API or labelled mocked seed data
- Dispute inbox + AI verdict for "item not received" and "not as described" reasons
- System-computed `base_win_probability` (deterministic rubric); system-computed recommendation (expected-value rule using `CHARGEBACK_FEE_USD` and `CONTEST_EFFORT_USD`); LLM explains and may override recommendation with a stated reason
- Merchant approve / edit / reject flow before any PayPal write call; approval idempotency; action executions in a separate append-only table
- Real write failures show an error and allow retry using the existing approved record and same `PayPal-Request-Id`; simulation only when `DEMO_MODE=true` or the dispute is `is_seed`/`is_demo`
- Learning loop: outcome recording, LLM-proposed weight changes with merchant approval and ±3 per-cycle cap
- Agent Activity log (Anthropic tool-use for structured output)
- MoneySafe AI dashboard (with simulated-outcome labelling on "Dollars protected")
- Reset-demo, simulate-dispute, and simulate-outcome utility actions
- Vercel + Supabase (Postgres only) deployment; public demo login credentials

**Out of scope**
- SQLite / local file database
- Real payment processing or production PayPal credentials
- Multi-merchant / team access
- Fraud-ring / velocity detection across merchants
- Dispute types beyond "item not received" and "not as described"
- Full authentication system (simple single-merchant demo login is sufficient)
- Transaction Search API (/v1/reporting/transactions) — optional, not required

---

## 3. Actors

| Actor | Description |
|---|---|
| Merchant | Primary user; the only entity whose approval can trigger a money-moving or weight-change action |
| PayPal Sandbox API | External system used to create/capture orders, fetch disputes, submit evidence, accept claims |
| Anthropic API | LLM called via tool-use for structured output; explains recommendation and may override with a stated reason — LLM output alone can never trigger an action |
| Tracking API | Free third-party carrier tracking API (or mocked seed data labelled "mocked") |
| System (automated) | Risk scoring engine, evidence assembler, recommendation engine, learning loop trigger |

---

## 4. Functional Requirements (EARS format)

### 4.1 Authentication

**REQ-AUTH-01** — Simple login  
*When* the merchant navigates to any protected page without a session, *the system shall* redirect them to a login page and grant access upon submitting the correct demo credentials without requiring a real auth provider.

**REQ-AUTH-02** — Public demo credentials  
*The system shall* expose a single set of public demo credentials documented in the README and on the deployed Vercel URL.

---

### 4.2 Order Risk Shield

**REQ-ORD-01** — App-owned orders table  
*The system shall* own a local `orders` table that stores each order with the following metadata: PayPal order ID, buyer email, buyer history flag (first-time / returning), payment attempt count, shipping method (standard / express / overnight / rush), billing country, shipping country, amount, currency, status, risk score, verdict, AI explanation, used_fallback flag, verification draft (for "Verify first" orders), evidence completeness score, signal breakdown (JSON), active `signal_weights` row ID, session ID, and seeded/demo flags. Orders are created via the PayPal Orders v2 create+capture flow (sandbox) or inserted as seed records. *The system shall not* rely on a PayPal list-orders endpoint; the local table is the system of record.

**REQ-ORD-02** — Risk score computation  
*When* an order is scored, *the system shall* compute a deterministic risk score from the following weighted signals, sum the active signal weights, and clamp the result to 0–100. The merchant's average order value *shall* be read from the `settings` table as a fixed seeded baseline of **$85** and *shall not* be recomputed from live orders.

| Signal | Default Weight |
|---|---|
| Billing country ≠ shipping country | 20 |
| First-time buyer AND amount > $200 | 20 |
| Rush / overnight shipping selected | 15 |
| Order value > 3 × merchant baseline average ($85) | 20 |
| Disposable-domain email (heuristic blocklist) | 15 |
| ≥ 3 payment attempts on this order | 10 |

*The system shall* map score to verdict: 0–39 → Ship (Low), 40–69 → Verify first (Medium), 70–100 → Hold (High).

**REQ-ORD-03** — Risk badge display  
*The system shall* display a colour-coded risk badge (green / amber / red) and verdict label on every order row and on the order detail page.

**REQ-ORD-04** — Signal breakdown  
*When* the merchant opens an order detail page, *the system shall* display each active signal with its weight contribution and the overall score.

**REQ-ORD-05** — AI plain-English explanation  
*When* an order has a risk score ≥ 1, *the system shall* call the Anthropic API (via tool use) to produce a plain-English explanation (≤ 120 words) validated by zod. *If* the LLM call fails, *the system shall* show the signal list with a visible "AI explanation unavailable" note and set `used_fallback = true`.

**REQ-ORD-06** — Verification message draft  
*When* the verdict is "Verify first", *the system shall* call the Anthropic API to draft a polite buyer-verification message (subject + body, ≤ 200 words). *If* the LLM call fails, *the system shall* display a static template.

**REQ-ORD-08** — Real sandbox order flow  
*When* the merchant creates a non-seed order, *the system shall* create a PayPal sandbox order, send the buyer to the PayPal approval URL, and on return capture the order, store the capture ID, then ingest and score it. A cancelled approval *shall* mark the order cancelled. *When* a non-seed order is marked shipped, *the system shall* send the tracking number and carrier to PayPal's add-tracking endpoint for that order; a failure there *shall* warn the merchant but not block evidence assembly.

**REQ-ORD-07** — Demo Mode indicator  
*Whenever* an order is populated with seeded data, *the system shall* display a visible "Demo data" badge.

---

### 4.3 Evidence Vault

**REQ-EV-01** — Evidence assembly on shipment  
*When* the merchant marks an order as shipped (tracking number + carrier), *the system shall* assemble and persist:

| Artefact | Source |
|---|---|
| Invoice / order summary | PayPal Orders v2 GET |
| Full order line items | PayPal Orders v2 GET |
| Buyer contact details | PayPal order + local orders table |
| Shipment tracking number and carrier | Merchant input |
| Tracking scan events | Free carrier tracking API, or seed data labelled **"mocked"** |
| Buyer communications | Communications logged in the system |

**REQ-EV-02** — Weighted evidence completeness score  
*The system shall* compute a weighted evidence completeness score (0–100 %) using the following split weights. The tracking artefact is split into two sub-criteria worth 15 points each:

| Artefact / sub-criterion | Weight |
|---|---|
| Invoice / order summary | 15 |
| Order line items | 15 |
| Buyer contact details | 15 |
| Tracking number + carrier | 15 |
| Tracking scan events present (any status) | 15 |
| Tracking scan events include a "Delivered" status | 15 |
| Buyer communications | 10 |
| **Total** | **100** |

**REQ-EV-03** — Evidence immutability  
*Once* stored, artefacts *shall not* be deleted or overwritten; new artefacts may only be appended.

**REQ-EV-04** — Evidence retrieval  
*When* the Dispute Defender agent processes a dispute, *the system shall* make all evidence artefacts available without requiring a manual lookup.

---

### 4.4 Dispute Defender

**REQ-DIS-01** — Dispute inbox  
Display open disputes sorted by deadline ascending; columns: reason, disputed amount, live deadline countdown, matched order reference. A separate **"Resolved" tab** *shall* display historical resolved disputes (including H1–H5 seed records and any disputes resolved during the session), sorted by resolved date descending. Resolved disputes *shall not* appear in the open inbox.

**REQ-DIS-02** — Deadline countdown  
Countdown shown in red when deadline is < 48 hours away.

**REQ-DIS-03** — System recommendation + AI analysis  

The **system** *shall* compute, before calling the LLM:
- `base_win_probability` — deterministic rubric (formula in design.md §6)
- `recommendation` — expected-value rule:

  ```
  contest iff: p × amount - (1 - p) × CHARGEBACK_FEE_USD - CONTEST_EFFORT_USD > 0
  ```

  where `p = base_win_probability`, `CHARGEBACK_FEE_USD` (default $20), `CONTEST_EFFORT_USD` (default $10). Otherwise recommend "refund".

The **Anthropic API** *shall* then be called via tool use (with `tool_choice: { type: 'tool', name: 'dispute_analysis' }`) and *shall* return only:

```
{
  llm_adjustment: number,                              // system clamps to [-0.1, +0.1]
  reasoning: string,                                   // ≤ 200 words; must state a reason if overriding
  override_recommendation: "contest" | "refund" | null,
  evidence_used: string[],
  evidence_gaps: string[]
}
```

If `override_recommendation` is non-null and differs from the system recommendation, the LLM's recommendation is used and `reasoning` must explain why. The system then computes:
- `win_probability` = clamp(`base_win_probability` + clamped `llm_adjustment`, **0.05**, **0.95**)
- `win_likelihood_label`: Strong (≥ 0.70) | Moderate (0.40–0.69) | Weak (< 0.40)

The final displayed recommendation is the LLM override if present, otherwise the system recommendation. The UI *shall* label the source: "System recommendation" or "AI-adjusted recommendation".

*If* the LLM call fails, *the system shall* display the system recommendation with a visible fallback note and no `win_likelihood_label`.

*Stretch (non-blocking):* during analysis the LLM may call a hard-coded read-only allowlist of PayPal Agent Toolkit tools to gather extra evidence. No write-capable tool is ever exposed to the LLM, and seeded disputes never use it.

**REQ-DIS-04** — Draft response  
*When* the final recommendation is "contest", *the system shall* call the Anthropic API (tool use, `tool_choice: { type: 'tool', name: 'dispute_draft_response' }`) to draft a response (editable rich text, ≤ 400 words) citing specific evidence. The approved payload (original or edited draft) is stored in `action_executions`.

**REQ-DIS-05** — Approve / Edit / Reject flow  
Before any PayPal write call:
- **Approve**: executes as drafted
- **Edit + Approve**: merchant edits; system records original and edited versions
- **Reject**: records rejection; no action executed

**REQ-DIS-06** — Approval record  
*When* the merchant approves or rejects, *the system shall* persist an immutable row in `approval_records` containing: dispute ID, action type, merchant user ID, timestamp (UTC), decision, and SHA-256 hash of the action payload.

**REQ-DIS-07** — Action executions table  
*After* a valid approval, *the system shall* insert a row into `action_executions` containing: approval record ID, dispute ID, action type, approved payload (original or edited), `PayPal-Request-Id` (UUID), PayPal response, executed_at (UTC), is_simulated flag.

**REQ-DIS-08** — Approval idempotency and retry  
*When* the merchant submits an approval, *the system shall* branch on existing state:
- *If* an approved record exists and its `action_executions` row has `executed_at` set, *the system shall* return "Action already executed" and insert nothing.
- *If* an approved record exists with an **unexecuted** `action_executions` row (a prior live call failed), *the system shall* retry the PayPal call using the same `PayPal-Request-Id` and insert nothing.
- *Otherwise* the system shall insert the approval record and the action execution, then execute.

**REQ-DIS-09** — PayPal action execution and retry  
*Only after* a valid, non-duplicate approval, *the system shall* determine whether to simulate or execute:
- **Simulate** (when `DEMO_MODE=true` OR `dispute.is_seed = true` OR `dispute.is_demo = true`): skip network call; mark `is_simulated = true`; set `executed_at`; log with status "simulated".
- **Execute live**: call the PayPal sandbox endpoint with the `PayPal-Request-Id` header set to `action_executions.paypal_request_id`. *If* the live call fails, *the system shall* surface an error to the merchant and allow retry via the retry branch of REQ-DIS-08.

For `not_as_described` disputes the evidence type *shall* be `DECLARATION` (with notes) by default; `PHOTOS_OF_SHIPPED_ITEM` *shall* be used only when a document is attached. For `item_not_received` it *shall* be `PROOF_OF_FULFILLMENT` with tracking information.

*When* `action_type = accept_claim` completes (whether live or simulated), *the system shall* automatically:
1. Set `disputes.outcome = 'refunded'` and `disputes.status = 'resolved_refunded'`.
2. Insert a row into `dispute_outcomes`.
3. Increment `signal_weights.resolved_since_last_proposal`.

No further merchant action is required to record a refund outcome.

**REQ-DIS-10** — Dispute timeline  
Chronological timeline: dispute created → evidence assembled → AI analysis completed → draft created → merchant decision → PayPal action executed (or simulated).

**REQ-DIS-11** — Simulate outcome (contest path only)  
*After* a `submit_evidence` action is executed or simulated on a dispute (i.e., `action_type = submit_evidence`), *the system shall* display a "Simulate outcome (Won / Lost)" control in Demo Mode. Selecting an option records the outcome labelled **"simulated outcome"**. This control does **not** appear after `accept_claim` actions — the refund outcome is recorded automatically (REQ-DIS-09). Real sandbox resolutions supersede simulated outcomes.

---

### 4.5 Learning Loop

**REQ-LL-01** — Outcome recording  
*When* a dispute is resolved (won / lost / refunded — real or simulated), *the system shall* record the outcome and increment the `resolved_since_last_proposal` counter on the active `signal_weights` row.

**REQ-LL-02** — LLM-proposed weight changes with merchant approval  
*When* `resolved_since_last_proposal` reaches 5, *the system shall* check whether a proposal is already pending (`proposal_created_at IS NOT NULL`). *If* a proposal is already pending, *the system shall* continue counting but *shall not* create a new proposal until the existing one is approved or rejected. *If* no proposal is pending, *the system shall* call the Anthropic API (tool use, `tool_choice: { type: 'tool', name: 'weight_proposal' }`), apply ±3 delta cap and [5, 30] per-weight clamp, store the proposal on the active `signal_weights` row, and reset the counter to 0. Merchant must approve before weights are applied. Approval logged as `merchant_action`.

**REQ-LL-03** — Insights page  
Loading the Insights page *shall not* call the LLM. The AI summary is cached in the database and regenerated only when the resolved outcomes or the pending proposal change. Shows: current signal weights (delta vs. baseline), any pending proposal (awaiting merchant approval), dispute outcome breakdown, LLM-generated summary (≤ 150 words, zod-validated, fallback available).

---

### 4.6 Agent Activity

**REQ-AA-01** — Activity log persistence  
Every agent step stored with: step ID, session ID, ref_order_id (nullable), ref_dispute_id (nullable), timestamp (UTC), step type (`paypal_api` | `llm_call` | `rule_engine` | `merchant_action`), tool name, PII-scrubbed input summary, output summary, duration_ms, status (`success` | `error` | `fallback` | `simulated`).

**REQ-AA-02** — Live-updating panel  
Reverse-chronological; polling every 5 seconds. Each entry shows: step type icon, tool name, timestamp, duration, status badge, expandable input/output summary.

**REQ-AA-03** — Activity linked to context  
On order and dispute detail pages, shows only entries for that record.

---

### 4.7 Dashboard

**REQ-DASH-01** — Key metrics (no double-counting)  

| Metric | Definition |
|---|---|
| Value under review | Sum of amounts for verdict = Hold orders (risk exposure, not confirmed outcome) |
| Disputes won | Count + total value of disputes won via contest path |
| Chargeback fees avoided | Count of accepted-refund disputes × `CHARGEBACK_FEE_USD` — fee savings only, not order value; never added to "Dollars protected" |
| Dollars protected | Sum of disputed amounts for won disputes only; a sub-label *shall* indicate how much of this total comes from simulated outcomes (e.g., "$X from simulated") |

**REQ-DASH-02** — Recent activity feed — 5 most recent agent activity entries.

**REQ-DASH-03** — Risk distribution chart — orders by verdict (Ship / Verify first / Hold).

---

### 4.8 Demo Utilities

**REQ-DU-01** — Reset demo  
Atomically truncates non-seed data, re-seeds all canonical records (including the pending weight-change proposal from REQ-DEMO-07), and resets `resolved_since_last_proposal` to 0.

**REQ-DU-02** — Simulate dispute  
"Simulate dispute" button on shipped order detail pages creates a synthetic open dispute for that order.

---

### 4.9 Demo Mode & Seed Data

**REQ-DEMO-01** — Automatic fallback  
*When* any PayPal sandbox **read** call fails (non-2xx or network error), *the system shall* return the corresponding seed record and log a Demo Mode event in Agent Activity. PayPal **write** calls (submit evidence, accept claim) are simulated only when `DEMO_MODE=true` or the dispute is `is_seed`/`is_demo`; live write failures on real disputes surface an error and allow retry (REQ-DIS-09).

**REQ-DEMO-02** — Required seed orders and scores  

Merchant baseline average order value: fixed at **$85** (stored in `settings` table; not derived from order history).

| Seed ID | Amount | Buyer type | Active signals | Weights | Score | Verdict |
|---|---|---|---|---|---|---|
| SEED-A | $145 | Returning | None | — | **0** | Ship (Low) |
| SEED-B | $210 | First-time | country_mismatch (20) + first_time_high_value (20) + rush_shipping (15) | 20+20+15 | **55** | Verify first (Medium) |
| SEED-D-ORD | $38 | Returning | None | — | **0** | Ship (Low) |
| SEED-E-ORD | $210 | First-time | country_mismatch (20) + first_time_high_value (20) | 20+20 | **40** | Verify first (Medium) |
| SEED-F | $320 | Returning | country_mismatch (20) + high_relative_value (20) + rush_shipping (15) + disposable_email (15) | 20+20+15+15 | **70** | Hold (High) |

Notes:
- SEED-B billing country ≠ shipping country; first-time buyer with $210 > $200; rush shipping.  
- SEED-F buyer is returning (no `first_time_high_value` signal). $320 > 3 × $85 = $255 → `high_relative_value` active.  
- SEED-F makes "Value under review" non-zero on first load.

**REQ-DEMO-03** — Open seed disputes (unactioned, shown in the open inbox)

These three disputes are seeded as **open** with no approval record and no action execution. They are the disputes the merchant acts on during the demo.

Seed disputes store a **deadline offset** (hours from now) rather than a fixed timestamp. At read time, `deadline_at` is computed as `now() + offset`. This ensures seed disputes never expire regardless of when the demo is run. Reset demo reseeds using the same offsets relative to the new `now()`.

| Seed ID | Dispute reason | Order | Deadline offset | Evidence state | base_win_prob | llm_adjustment (seeded) | win_probability (displayed) | Recommendation |
|---|---|---|---|---|---|---|---|---|
| SEED-C | Item not received | Order A (SEED-A, $145) | +72 h | Full evidence + Delivered tracking | 1.000 → clamped | **0** | **95%** (Strong) | Contest |
| SEED-D | Not as described | Order D (SEED-D-ORD, $38) | +48 h | Partial — no tracking events, no buyer comms | 0.267 | **0** | **27%** (Weak) | Refund |
| SEED-E | Item not received | Order E (SEED-E-ORD, $210) | +40 h (red countdown) | In Transit tracking only, no Delivered scan | 0.444 | **0** | **44%** (Moderate) | **Contest** |

Notes:
- All seeded analyses use `llm_adjustment = 0` so displayed values are deterministic.
- `win_probability = clamp(base_win_probability + 0, 0.05, 0.95)`.
- SEED-C: base = 1.000, clamped to **0.95** → **95%**.
- SEED-D: base ≈ 0.267 → **27%**.
- SEED-E: base ≈ 0.444 → **44%**; EV = 0.444×210 − 0.556×20 − 10 = 93.2 − 11.1 − 10 = **72.1 > 0** → Contest.
- SEED-E at +40 h demonstrates the red countdown (< 48 h).

**REQ-DEMO-04** — Historical resolved disputes (shown in "Resolved" tab; excluded from open inbox)

Five historical disputes (H1–H5) are seeded as already resolved. Each has its own order, evidence artefacts, and risk snapshot. They populate the Insights learning loop data on first load without requiring the judge to walk through the dispute flow. All H1–H5 rows carry `is_seed = true`; the UI *shall* display a **"Demo data"** badge on their rows in the Resolved tab and on their detail pages.

| Seed ID | Outcome | Dispute reason | Amount | Notes |
|---|---|---|---|---|
| H1 | Won | Item not received | $89 | Full evidence, Delivered tracking |
| H2 | Won | Item not received | $134 | Full evidence, Delivered tracking |
| H3 | Lost | Not as described | $210 | Weak evidence, buyer comms show product mismatch |
| H4 | Refunded | Item not received | $42 | Low amount, EV favoured refund |
| H5 | Refunded | Not as described | $67 | Partial evidence, merchant proactively refunded |

H1–H5 each have their own seed order (H1-ORD through H5-ORD). Their `dispute_outcomes` rows are seeded directly.

**REQ-DEMO-05** — Tracking events labelled "mocked"  
Seed tracking events are labelled **"mocked"** in the Evidence Vault.

**REQ-DEMO-06** — Demo badge placement  
"Demo data" badge on every UI component displaying seed data.

**REQ-DEMO-07** — Seeded pending weight-change proposal  
One pre-seeded pending (unapproved) weight-change proposal on the Insights page; recreated by Reset demo.

---

## 5. Non-Functional Requirements

**REQ-NFR-01** — Labelling honesty  
Labels *shall* read "explainable risk signals + AI reasoning". Never "trained fraud model" or "AI fraud detection".

**REQ-NFR-02** — LLM output validation  
Every LLM response validated by zod before use. Failures fall back to rule-based output and are logged.

**REQ-NFR-03** — No money-moving action without approval  
No PayPal write endpoint — real or simulated — *shall* be called without a stored approval record. Covered by unit test.

**REQ-NFR-04** — Environment-based configuration  
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `DEMO_MODE`, `DATABASE_URL`, `CHARGEBACK_FEE_USD` (default `20`), `CONTEST_EFFORT_USD` (default `10`), `DEMO_PASSWORD`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`.

**REQ-NFR-05** — Type safety  
TypeScript strict mode throughout. All API I/O typed and validated with zod.

**REQ-NFR-06** — Responsive UI  
Usable at ≥ 375 px (mobile) and ≥ 1280 px (desktop).

**REQ-NFR-07** — Loading and empty states  
Every data-fetching component shows a loading skeleton and a meaningful empty state.

**REQ-NFR-08** — Unit tests: scoring  
Risk scoring engine tests: each individual signal, all six signals simultaneously (verify clamp to 100), boundary verdicts (39/40, 69/70), weight changes from learning loop, **seed score assertions**: SEED-A = 0, SEED-B = 55, SEED-D-ORD = 0, SEED-E-ORD = 40, SEED-F = 70.

**REQ-NFR-09** — Unit test: no-write-without-approval invariant  
Mocked PayPal service layer; assert that dispute write functions called without a prior approval record throw or return an error.

**REQ-NFR-10** — Unit test: base_win_probability, win_probability clamp, and EV rule  
- Assert SEED-C `base_win_probability = 1.000`; `win_probability = clamp(1.000 + 0, 0.05, 0.95) = 0.95`.
- Assert SEED-D `base_win_probability ≈ 0.267`; `win_probability ≈ 0.267` (not clamped).
- Assert SEED-E `base_win_probability ≈ 0.444`; `win_probability ≈ 0.444` (not clamped).
- Assert NAD dispute with full evidence (completeness=100, buyer comms present) → base ≈ (40+0+10)/90 ≈ 0.556 (B=0 for NAD; max NAD base ≈ 0.56 by design).
- Assert `computeWinProbability(1.0, 0.2)` = 0.95 (upper clamp).
- Assert `computeWinProbability(0.0, -0.2)` = 0.05 (lower clamp).
- EV rule tests (fee=$20, effort=$10):
  - `($145, 0.90)` → contest (`0.9×145 − 0.1×20 − 10 = 118.5 > 0`)
  - `($38, 0.40)` → refund (`0.4×38 − 0.6×20 − 10 = −6.8 < 0`)
  - `($60, 0.30)` → refund (`0.3×60 − 0.7×20 − 10 = −6 < 0`)

**REQ-NFR-11** — Untrusted input isolation  
Buyer messages, dispute reason text, and order line item names (injected as product descriptions) originating outside the system *shall* be treated as untrusted data in all LLM prompts. They *shall* be injected only into clearly delimited `<data>` XML tag sections, never into the instruction section. LLM output alone *shall* never trigger any action.

**REQ-NFR-12** — Postgres only  
Supabase Postgres is the only supported database. No SQLite path.

**REQ-NFR-13** — Anthropic tool use with per-call `tool_choice`  
All structured LLM output *shall* use Anthropic tool use. Each call *shall* use `tool_choice: { type: 'tool', name: '<tool_name>' }` to pin the model to the specific tool for that call (not `{ type: 'any' }`). All tool responses validated by zod post-parse.

**REQ-NFR-14** — POST-triggered analysis (cached)  
Dispute analysis *shall* be triggered by `POST /api/disputes/[id]/analyze`, not by a GET request. Results are cached in the `disputes` table. For seeded disputes, analysis is pre-computed at seed time.

**REQ-NFR-15** — PayPal-Request-Id idempotency header  
All PayPal write calls *shall* include a `PayPal-Request-Id` header set to `action_executions.paypal_request_id`. On retry of a failed live call, the same `paypal_request_id` *shall* be reused.

**REQ-NFR-17** — LLM budget with graceful fallback  
*Before* every LLM call, *the system shall* check a per-session limit (10 calls per rolling hour) and a global daily cap (`LLM_DAILY_CAP`, default 300 per UTC day). *If* either is exceeded, *the system shall* skip the LLM, return the rule-based result with the visible note "AI unavailable — showing rule-based result", and log the event in Agent Activity. *The system shall not* return HTTP 429 for this condition. Seeded disputes and the Insights page *shall* remain fully usable with the budget exhausted.

**REQ-NFR-18** — API session protection and health check  
*The system shall* require a valid session on every `/api/*` route except `/api/demo/status`. `GET /api/demo/status` *shall* execute `SELECT 1` against the database and report database health, so the scheduled keep-alive request also keeps the database active.

**REQ-NFR-16** — Deployment  
Vercel + Supabase. `README.md` documents env vars, public demo login, and a one-command local dev setup.

---

## 6. UI Pages Summary

| Page | Route | Primary purpose |
|---|---|---|
| Dashboard | `/` | MoneySafe AI metrics + recent activity |
| Orders | `/orders` | Sortable order list with risk badges |
| Order Detail | `/orders/[id]` | Risk breakdown, evidence vault, agent activity |
| Dispute Inbox | `/disputes` | Open disputes sorted by deadline |
| Dispute Detail | `/disputes/[id]` | Timeline, AI verdict, draft, approve/edit/reject, simulate outcome |
| Insights | `/insights` | Signal weights, outcomes, pending weight-change proposal |
| Agent Activity | `/activity` | Full activity log |
| Login | `/login` | Demo credential login |

---

## 7. Acceptance Criteria Summary

A submission *passes* when:
1. Every EARS "shall" is verifiably demonstrated.
2. No money-moving PayPal call (real or simulated) is made without a stored approval record (REQ-NFR-03).
3. Action executions stored in `action_executions`; idempotency prevents double-execution (REQ-DIS-07, REQ-DIS-08).
4. Real live write failures surface an error with retry option; simulation only for demo/seed disputes (REQ-DIS-09, REQ-DEMO-01).
5. All LLM responses have passed zod validation (REQ-NFR-02); each call uses per-tool `tool_choice` (REQ-NFR-13).
6. Demo Mode activates for reads; "Demo data" and "simulated" badges visible where applicable (REQ-DEMO-01, REQ-DEMO-06, REQ-DIS-09).
7. All seed records reachable; Insights populated on first load from H1–H5 historical disputes; SEED-C/D/E appear in the open inbox; pending weight-change proposal visible (REQ-DEMO-02–REQ-DEMO-07).
8. Unit tests pass: scoring seed assertions, no-write invariant, base_win_probability + EV rule (REQ-NFR-08–REQ-NFR-10).
9. Dashboard "Dollars protected" labels the simulated-outcome portion (REQ-DASH-01).
10. App deploys to Vercel + Supabase with a public demo login (REQ-NFR-16, REQ-AUTH-02).
11. Buyer/dispute text treated as untrusted input; LLM output never directly triggers an action (REQ-NFR-11).
12. Seed scores: SEED-A=0, SEED-B=55, SEED-D-ORD=0, SEED-E-ORD=40, SEED-F=70 (REQ-DEMO-02, REQ-NFR-08).
13. Seeded open disputes display deterministic win_probability: SEED-C=95%, SEED-D=27%, SEED-E=44% (REQ-DEMO-03, REQ-NFR-10).
14. Learning loop does not create a new proposal while one is already pending (REQ-LL-02).
