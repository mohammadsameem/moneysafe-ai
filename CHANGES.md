# Changes

Notable changes to the spec and architecture, newest first. Task-by-task progress lives in `tasks.md`; this file records decisions that changed direction.

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
