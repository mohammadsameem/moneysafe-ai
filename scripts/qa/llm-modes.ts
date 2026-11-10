/**
 * What does the RUNNING server do with its current LLM configuration? (task M4-09, "LLM fallback")
 *
 *   QA_EXPECT=ai|fallback npm run qa:llm
 *
 * It creates one demo order that scores as "Verify first" (so the model is asked for an explanation AND a draft),
 * under a throw-away session, then reports from the database:
 *   - whether the order used the rule-based fallback (the "AI unavailable" note),
 *   - whether the AI text is present,
 *   - every llm_call row logged for it (tool, status) - the primary's failure and the fallback provider's success both show,
 * and, if QA_EXPECT is set, passes or fails on `ai` (real model text, no fallback note) or `fallback` (rule-based text and
 * the note). Whatever happens, the order must be created (201) with its rule-based score. Keys are never printed.
 *
 * Restart the server with the configuration to test, for example (PowerShell, from the project folder):
 *   $env:LLM_API_KEY=' ';                         npm run dev     # no key at all (a space: PowerShell deletes a variable set to '')
 *   $env:LLM_API_KEY='x'; $env:LLM_FALLBACK_API_KEY='x'; npm run dev   # both invalid
 *   $env:LLM_FALLBACK_API_KEY='x';                npm run dev     # valid primary, invalid fallback
 *   $env:LLM_API_KEY='x';                         npm run dev     # invalid primary, valid fallback
 * The server needs DEMO_MODE=true so that creating an order does not need PayPal.
 */
import { BASE, call, check, cleanup, closeDb, finish, getSql, guardLocalOnly, info, json, noteFailure, signIn, visible } from "./common";

// first-time buyer over $200 (20) + countries differ (20) + rush (15) = 55: "Verify first", so the model is asked for an
// explanation AND a draft message. $250 stays under 3 x $85, so no relative-value signal turns it into a Hold.
const RISKY = { itemName: "LLM mode check", amountUsd: 250, shippingMethod: "rush", billingCountry: "US", shippingCountry: "NG", paymentAttemptCount: 1 } as const;

async function main(): Promise<void> {
  guardLocalOnly();
  const expect = process.env.QA_EXPECT;
  const me = await signIn();
  try {
    const t0 = Date.now();
    const res = await call(me, "POST", "/api/orders", RISKY);
    const body = await json(res);
    check("the order is created (201) whatever the model does", res.status === 201, `${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const id = String(body.orderId);

    const sql = getSql();
    const [o] = await sql<{ risk_score: number | null; verdict: string | null; used_fallback: boolean; ai_explanation: string | null; verification_draft: unknown }[]>`
      SELECT risk_score, verdict, used_fallback, ai_explanation, verification_draft FROM orders WHERE id = ${id}`;
    const llmRows = await sql<{ tool_name: string; status: string; duration_ms: number }[]>`
      SELECT tool_name, status, duration_ms FROM agent_activity WHERE ref_order_id = ${id} AND step_type = 'llm_call' ORDER BY created_at`;

    check("  ...it has its rule-based score and verdict", (o?.risk_score ?? 0) > 0 && o?.verdict !== null, `${o?.verdict}/${o?.risk_score}`);
    const page = visible(await (await call(me, "GET", `/orders/${id}`)).text());
    const noteShown = page.includes("AI unavailable");
    const hasText = Boolean(o?.ai_explanation) && (o?.verdict !== "verify" || o?.verification_draft !== null);
    info(`used_fallback=${o?.used_fallback}; AI explanation + draft stored=${hasText}; 'AI unavailable' note on the page=${noteShown}`);
    info(`llm_call rows: ${llmRows.map((r) => `${r.tool_name}:${r.status}(${r.duration_ms}ms)`).join(", ") || "(none logged)"}`);
    check("  ...the order page has an explanation to show, either way", page.includes("Why this score"));

    if (expect === "fallback") {
      check("expected FALLBACK: flagged as rule-based and the page says 'AI unavailable'", o?.used_fallback === true && noteShown);
      check("  ...the explanation and the draft are still there (rule-based text), never an empty section", hasText);
    } else if (expect === "ai") {
      check("expected AI: not flagged as fallback, no 'AI unavailable' note, AI explanation and draft stored", o?.used_fallback === false && !noteShown && hasText);
    } else {
      info("QA_EXPECT is not set (ai or fallback), so this run only reported");
    }
  } finally {
    await cleanup([me.sid]).catch(() => noteFailure("cleanup failed"));
    await closeDb();
  }
  void BASE;
}

main()
  .catch((err: unknown) => noteFailure(`unexpected error: ${(err instanceof Error ? err.message : String(err)).slice(0, 240)}`))
  .finally(finish);
