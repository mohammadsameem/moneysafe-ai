import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSIGHTS_LLM_TIMEOUT_MS } from "@/lib/ai/insights";
import { LLM_PROVIDER_TIMEOUT_MS } from "@/lib/ai/providers";

/**
 * Vercel's Hobby limit, per its docs (checked 2026-11-08): with Fluid compute (the default) a
 * function may run up to 300 s; without it, the older limit is 60 s. The routes declare 60 so they
 * are valid under both, and the worst case below must fit inside it with room to spare.
 */
const HOBBY_STRICTEST_MAX_SECONDS = 60;
const SAFETY_MARGIN_SECONDS = 15; // database work, PayPal calls, cold start
const PROVIDERS = 2; // primary + fallback

interface RouteBudget {
  /** Model calls made one after another. */
  calls: number;
  /** Seconds ONE provider gets per call. Defaults to LLM_PROVIDER_TIMEOUT_MS (8 s). */
  providerSeconds?: number;
  /** Other slow work that can precede the model calls on the same request, in seconds. */
  otherSeconds?: number;
}

/** Learning-loop calls (a proposal, a refreshed summary) get the tighter allowance. */
const LOOP_SECONDS = INSIGHTS_LLM_TIMEOUT_MS / 1000;

/** Routes that can reach a model, and how many model calls they make one after another. */
const MODEL_ROUTES: Record<string, RouteBudget> = {
  "disputes/[id]/analyze/route.ts": { calls: 2 }, // the analysis, then (for a contest) the draft
  "orders/route.ts": { calls: 1 }, // a demo order: explanation and verification draft run in parallel
  "orders/paypal-return/route.ts": { calls: 1 },
  // A refund is an outcome: the learning loop may propose weights, then refresh the summary. A live
  // PayPal write precedes it (one request, at most its 20 s timeout; a failed write never reaches the loop).
  "disputes/[id]/approve/route.ts": { calls: 2, providerSeconds: LOOP_SECONDS, otherSeconds: 20 },
  "disputes/[id]/simulate-outcome/route.ts": { calls: 2, providerSeconds: LOOP_SECONDS },
  // Approving or rejecting weights changes what the cached summary describes: one refresh call.
  "insights/approve-weights/route.ts": { calls: 1, providerSeconds: LOOP_SECONDS },
  "insights/reject-weights/route.ts": { calls: 1, providerSeconds: LOOP_SECONDS },
  // Reset demo re-seeds the Insights cache, so the follow-up refresh is a cache hit; it still CAN call a model.
  "demo/reset/route.ts": { calls: 1, providerSeconds: LOOP_SECONDS },
};

/** Routes that build the model-capable dependencies but never call a model, with the reason. */
const NEVER_CALLS_A_MODEL: Record<string, string> = {
  "orders/paypal-cancel/route.ts": "only marks an unpaid order cancelled (handlePayPalCancel has no AI step)",
  "disputes/[id]/reject/route.ts": "records a rejection; rejectDispute only reads and writes the approval log, it never creates an outcome",
  "disputes/simulate/route.ts": "opens a synthetic dispute; simulateDispute has no AI step and creates no outcome",
};

const apiDir = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? (name === "__tests__" ? [] : walk(full)) : name === "route.ts" ? [full] : [];
  });
const routes = walk(apiDir).map((f) => ({ file: f.slice(apiDir.length + 1).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));
const maxDurationOf = (text: string): number | null => {
  const m = /export const maxDuration\s*=\s*(\d+)\s*;/.exec(text);
  return m ? Number(m[1]) : null;
};

describe("route time limits vs. the LLM timeout", () => {
  it("every route that can reach a model is listed here (a new one must be added deliberately)", () => {
    const reachesModel = routes
      .filter((r) => /buildAnalyzeDeps|buildOrderDeps|buildApproveDeps|buildSimulationDeps|buildResetDeps|getLlmDeps|insights\/runtime|llm\/|lib\/ai\//.test(r.text))
      .map((r) => r.file)
      .filter((f) => !(f in NEVER_CALLS_A_MODEL))
      .sort();
    expect(reachesModel).toEqual(Object.keys(MODEL_ROUTES).sort());
  });

  it("the routes excused above really have no AI step", () => {
    const cancel = readFileSync(join(__dirname, "..", "..", "..", "lib", "orders", "service.ts"), "utf8");
    const body = cancel.slice(cancel.indexOf("export async function handlePayPalCancel"));
    expect(body).not.toMatch(/deps\.ai|ingestAndScore/);
  });

  it.each(Object.entries(MODEL_ROUTES))("%s declares maxDuration, within the Hobby limit, with the worst case + margin inside it", (file, budget) => {
    const route = routes.find((r) => r.file === file);
    expect(route, file).toBeDefined();
    const declared = maxDurationOf(route!.text);
    expect(declared, `${file} must export const maxDuration = <number>;`).not.toBeNull();
    expect(declared!).toBeLessThanOrEqual(HOBBY_STRICTEST_MAX_SECONDS);

    // Each provider gets its allowance in total per call (pinned attempt + JSON retry share it).
    const worstCaseSeconds = (budget.providerSeconds ?? LLM_PROVIDER_TIMEOUT_MS / 1000) * PROVIDERS * budget.calls + (budget.otherSeconds ?? 0);
    expect(worstCaseSeconds + SAFETY_MARGIN_SECONDS, `${file}: ${worstCaseSeconds}s worst case`).toBeLessThanOrEqual(declared!);
  });

  it("the analysis worst case is 32 seconds (2 providers x 8 s x 2 sequential calls)", () => {
    expect((LLM_PROVIDER_TIMEOUT_MS / 1000) * PROVIDERS * MODEL_ROUTES["disputes/[id]/analyze/route.ts"]!.calls).toBe(32);
  });

  it("a learning-loop call gets 5 s per provider, so two in a row take at most 20 s", () => {
    expect(INSIGHTS_LLM_TIMEOUT_MS).toBe(5_000);
    expect(LOOP_SECONDS * PROVIDERS * 2).toBe(20);
  });

  it("no route outside the list declares a different budget by accident", () => {
    for (const r of routes) {
      const d = maxDurationOf(r.text);
      if (d !== null) expect(d, r.file).toBeLessThanOrEqual(HOBBY_STRICTEST_MAX_SECONDS);
    }
  });
});
