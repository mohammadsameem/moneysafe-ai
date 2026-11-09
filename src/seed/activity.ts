/**
 * Hand-written agent_activity rows so the dashboard feed and /activity are not empty on first load
 * (fix 4). They describe what the agent "did" for the seeded orders and disputes, are consistent
 * with the seeded numbers, and are clearly demo data:
 *
 *   - every id is a deterministic seed id (`seedId("activity", key)`), so the seed runner upserts
 *     them in place and Reset demo (M4-05) can recognise and restore them;
 *   - every row carries SEED_ACTIVITY_SESSION_ID as its session id (no real session can have it:
 *     real ones are random UUIDs), and its output summary starts with "Demo data:".
 *
 * agent_activity has no is_seed column; `isSeedActivity` is the one test for "is this seeded".
 */
import type { NewAgentActivityRow } from "../db/schema";
import { seedId } from "./ids";

export const SEED_ACTIVITY_SESSION_ID = "seed-demo";
export const SEED_ACTIVITY_PREFIX = "Demo data: ";

const HOUR = 3_600_000;
const at = (now: Date, hoursAgo: number): string => new Date(now.getTime() - hoursAgo * HOUR).toISOString();

interface Spec {
  key: string;
  hoursAgo: number;
  orderKey?: string;
  disputeKey?: string;
  stepType: NewAgentActivityRow["stepType"];
  toolName: string;
  inputSummary: string;
  output: string;
  durationMs: number;
  status: NewAgentActivityRow["status"];
}

/** Oldest first. Times line up with the seeded orders (SEED-B 20 h ago, SEED-F 5 h ago) and disputes (SEED-C 30 h, SEED-E 10 h). */
const SPECS: Spec[] = [
  {
    key: "SEED-C-assess",
    hoursAgo: 29,
    disputeKey: "SEED-C",
    orderKey: "SEED-A",
    stepType: "rule_engine",
    toolName: "assess_dispute",
    inputSummary: "item_not_received; 8 evidence artefacts; amount 145.00 USD",
    output: "completeness 100%; base 100%; EV 135.00 USD; system recommends contest",
    durationMs: 4,
    status: "success",
  },
  {
    key: "SEED-C-analysis",
    hoursAgo: 29,
    disputeKey: "SEED-C",
    orderKey: "SEED-A",
    stepType: "llm_call",
    toolName: "dispute_analysis",
    inputSummary: "item_not_received; base 100%; system recommends contest | provider=groq (primary) model=openai/gpt-oss-120b mode=tool",
    output: "ok; win likelihood 95% Strong (capped at 95%)",
    durationMs: 1840,
    status: "success",
  },
  {
    key: "SEED-B-score",
    hoursAgo: 20,
    orderKey: "SEED-B",
    stepType: "rule_engine",
    toolName: "score_order",
    inputSummary: "amount=210 USD shipping=rush US->GB attempts=1",
    output: "score 55 -> verify; active signals: country_mismatch, first_time_high_value, rush_shipping",
    durationMs: 3,
    status: "success",
  },
  {
    key: "SEED-B-draft",
    hoursAgo: 20,
    orderKey: "SEED-B",
    stepType: "llm_call",
    toolName: "verification_draft",
    inputSummary: "score 55 -> verify; active signals: country_mismatch, first_time_high_value, rush_shipping | provider=groq (primary) model=openai/gpt-oss-120b mode=tool",
    output: "ok; verification message drafted for your review",
    durationMs: 1320,
    status: "success",
  },
  {
    key: "SEED-E-refresh",
    hoursAgo: 9.5,
    disputeKey: "SEED-E",
    orderKey: "SEED-E-ORD",
    stepType: "paypal_api",
    toolName: "get_dispute",
    inputSummary: "refresh deadline from PayPal",
    output: "Demo Mode (seeded dispute); used the stored record, nothing was requested from PayPal",
    durationMs: 1,
    status: "simulated",
  },
  {
    key: "SEED-E-assess",
    hoursAgo: 9.5,
    disputeKey: "SEED-E",
    orderKey: "SEED-E-ORD",
    stepType: "rule_engine",
    toolName: "assess_dispute",
    inputSummary: "item_not_received; 5 evidence artefacts; amount 210.00 USD",
    output: "completeness 75%; base 44%; EV 72.44 USD; system recommends contest",
    durationMs: 3,
    status: "success",
  },
  {
    key: "SEED-F-score",
    hoursAgo: 5,
    orderKey: "SEED-F",
    stepType: "rule_engine",
    toolName: "score_order",
    inputSummary: "amount=320 USD shipping=rush US->DE attempts=1",
    output: "score 70 -> hold; active signals: country_mismatch, rush_shipping, high_relative_value, disposable_email",
    durationMs: 3,
    status: "success",
  },
  {
    key: "SEED-F-explain",
    hoursAgo: 5,
    orderKey: "SEED-F",
    stepType: "llm_call",
    toolName: "risk_explanation",
    inputSummary: "score 70 -> hold; active signals: country_mismatch, rush_shipping, high_relative_value, disposable_email | provider=groq (primary) model=openai/gpt-oss-120b mode=tool",
    output: "ok; plain-English explanation saved",
    durationMs: 1510,
    status: "success",
  },
];

/** The seeded activity rows, timed relative to `now`. */
export function buildSeedActivity(now: Date): NewAgentActivityRow[] {
  return SPECS.map((s) => ({
    id: seedId("activity", s.key),
    refOrderId: s.orderKey ? seedId("order", s.orderKey) : null,
    refDisputeId: s.disputeKey ? seedId("dispute", s.disputeKey) : null,
    sessionId: SEED_ACTIVITY_SESSION_ID,
    stepType: s.stepType,
    toolName: s.toolName,
    inputSummary: s.inputSummary,
    outputSummary: `${SEED_ACTIVITY_PREFIX}${s.output}`,
    durationMs: s.durationMs,
    status: s.status,
    createdAt: at(now, s.hoursAgo),
  }));
}

/** True for the seeded rows (and only them). */
export function isSeedActivity(row: { sessionId: string | null }): boolean {
  return row.sessionId === SEED_ACTIVITY_SESSION_ID;
}

/** The ids of every seeded activity row, for Reset demo. */
export function seedActivityIds(): string[] {
  return SPECS.map((s) => seedId("activity", s.key));
}
