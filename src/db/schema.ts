/**
 * Drizzle schema for MoneySafe AI (Postgres only). Mirrors design.md section 3 exactly.
 *
 * Conventions (design.md section 3):
 *  - Every table with a uuid PK generates it client-side with crypto.randomUUID().
 *  - Timestamps are ISO-8601 UTC strings stored as text.
 *  - The string unions below are TypeScript-level only (no DB CHECK constraints), as in the design.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Allowed values (documented in the design as `a|b|c` comments)
// ---------------------------------------------------------------------------
export const SHIPPING_METHODS = ["standard", "express", "overnight", "rush"] as const;
export const ORDER_STATUSES = ["created", "captured", "shipped", "cancelled"] as const;
export const VERDICTS = ["ship", "verify", "hold"] as const;
export const ARTEFACT_TYPES = [
  "invoice_summary",
  "line_items",
  "buyer_contact",
  "tracking_info",
  "tracking_events",
  "buyer_communication",
] as const;
export const ARTEFACT_SOURCES = ["paypal_api", "merchant_input", "tracking_api", "mocked", "seed"] as const;
export const DISPUTE_REASONS = ["item_not_received", "not_as_described"] as const;
export const DISPUTE_STATUSES = [
  "open",
  "action_taken",
  "resolved_won",
  "resolved_lost",
  "resolved_refunded",
  // A real PayPal dispute that PayPal closed without a refund or a win we can name (cancelled, denied, withdrawn).
  "resolved_closed",
] as const;
export const DISPUTE_OUTCOMES = ["won", "lost", "refunded"] as const;
export const WIN_LIKELIHOOD_LABELS = ["Strong", "Moderate", "Weak"] as const;
export const RECOMMENDATIONS = ["contest", "refund"] as const;
export const RECOMMENDATION_SOURCES = ["system", "ai_adjusted"] as const;
export const ACTION_TYPES = ["submit_evidence", "accept_claim"] as const;
export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export const ACTIVITY_STEP_TYPES = ["paypal_api", "llm_call", "rule_engine", "merchant_action"] as const;
export const ACTIVITY_STATUSES = ["success", "error", "fallback", "simulated"] as const;

// ---------------------------------------------------------------------------
// JSON column shapes
// ---------------------------------------------------------------------------
export type VerificationDraft = { subject: string; body: string };
export type SignalBreakdownItem = { signal: string; active: boolean; weight: number };
/** Artefact payloads get strict zod types in the evidence task; the column itself is untyped JSON. */
export type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared column builders
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const pk = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => text("created_at").notNull().$defaultFn(nowIso);
const updatedAt = () => text("updated_at").notNull().$defaultFn(nowIso).$onUpdateFn(nowIso);
/** Postgres `numeric`, returned to JS as a number (not a string). */
const num = (name: string) => numeric(name, { mode: "number" });

// ---------------------------------------------------------------------------
// 3.1 orders
// ---------------------------------------------------------------------------
export const orders = pgTable("orders", {
  id: pk(),
  paypalOrderId: text("paypal_order_id").unique(),
  /** purchase_units[0].payments.captures[0].id; required by PayPal add-tracking. */
  paypalCaptureId: text("paypal_capture_id"),
  buyerEmail: text("buyer_email").notNull(),
  buyerIsFirstTime: boolean("buyer_is_first_time").notNull(),
  paymentAttemptCount: integer("payment_attempt_count").notNull().default(1),
  shippingMethod: text("shipping_method", { enum: SHIPPING_METHODS }).notNull(),
  billingCountry: varchar("billing_country", { length: 2 }).notNull(),
  shippingCountry: varchar("shipping_country", { length: 2 }).notNull(),
  amountUsd: num("amount_usd").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  status: text("status", { enum: ORDER_STATUSES }).notNull(),
  riskScore: integer("risk_score"),
  verdict: text("verdict", { enum: VERDICTS }),
  aiExplanation: text("ai_explanation"),
  usedFallback: boolean("used_fallback").notNull().default(false),
  verificationDraft: jsonb("verification_draft").$type<VerificationDraft>(),
  /** 0-100 */
  evidenceCompleteness: integer("evidence_completeness"),
  signalBreakdown: jsonb("signal_breakdown").$type<SignalBreakdownItem[]>(),
  weightsId: uuid("weights_id").references(() => signalWeights.id),
  sessionId: text("session_id"),
  isSeed: boolean("is_seed").notNull().default(false),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// 3.2 settings (single row; fee and effort assumptions live in env, not here)
// ---------------------------------------------------------------------------
export const settings = pgTable("settings", {
  id: pk(),
  merchantAvgOrderValueUsd: num("merchant_avg_order_value_usd").notNull().default(85),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// 3.3 evidence_artefacts (append-only; enforced at the service layer)
// ---------------------------------------------------------------------------
export const evidenceArtefacts = pgTable("evidence_artefacts", {
  id: pk(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  artefactType: text("artefact_type", { enum: ARTEFACT_TYPES }).notNull(),
  payload: jsonb("payload").$type<JsonObject>().notNull(),
  source: text("source", { enum: ARTEFACT_SOURCES }).notNull(),
  isMocked: boolean("is_mocked").notNull().default(false),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 3.4 disputes
// ---------------------------------------------------------------------------
export const disputes = pgTable("disputes", {
  id: pk(),
  paypalDisputeId: text("paypal_dispute_id").unique(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  reason: text("reason", { enum: DISPUTE_REASONS }).notNull(),
  /** Untrusted input: only ever placed inside <data> sections of LLM prompts. */
  buyerMessage: text("buyer_message"),
  disputedAmountUsd: num("disputed_amount_usd").notNull(),
  /** Hours from now; set for is_seed disputes so deadline_at is computed at read time. */
  deadlineOffsetHours: integer("deadline_offset_hours"),
  /** Placeholder '2099-01-01T00:00:00Z' for seeds (overwritten at read time). */
  deadlineAt: text("deadline_at").notNull(),
  status: text("status", { enum: DISPUTE_STATUSES }).notNull(),
  outcome: text("outcome", { enum: DISPUTE_OUTCOMES }),
  outcomeIsSimulated: boolean("outcome_is_simulated").notNull().default(false),
  baseWinProbability: num("base_win_probability"),
  /** From the LLM, clamped by the system to [-0.1, +0.1]; 0 for seeded analyses. */
  llmAdjustment: num("llm_adjustment"),
  /** clamp(base + llm_adjustment, 0.05, 0.95) */
  winProbability: num("win_probability"),
  winLikelihoodLabel: text("win_likelihood_label", { enum: WIN_LIKELIHOOD_LABELS }),
  systemRecommendation: text("system_recommendation", { enum: RECOMMENDATIONS }),
  overrideRecommendation: text("override_recommendation", { enum: RECOMMENDATIONS }),
  finalRecommendation: text("final_recommendation", { enum: RECOMMENDATIONS }),
  recommendationSource: text("recommendation_source", { enum: RECOMMENDATION_SOURCES }),
  reasoning: text("reasoning"),
  evidenceUsed: jsonb("evidence_used").$type<string[]>(),
  evidenceGaps: jsonb("evidence_gaps").$type<string[]>(),
  draftResponse: text("draft_response"),
  /** Cache marker: POST /analyze skips the work when this is non-null. */
  analysisComputedAt: text("analysis_computed_at"),
  riskScoreSnapshot: integer("risk_score_snapshot"),
  sessionId: text("session_id"),
  isSeed: boolean("is_seed").notNull().default(false),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// 3.5 approval_records (append-only)
// ---------------------------------------------------------------------------
export const approvalRecords = pgTable(
  "approval_records",
  {
    id: pk(),
    disputeId: uuid("dispute_id")
      .notNull()
      .references(() => disputes.id),
    actionType: text("action_type", { enum: ACTION_TYPES }).notNull(),
    merchantUserId: text("merchant_user_id").notNull(),
    decision: text("decision", { enum: APPROVAL_DECISIONS }).notNull(),
    /** SHA-256 of the action payload. */
    payloadHash: text("payload_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // At most one APPROVED record per (dispute, action). Rejections are unconstrained.
    uniqueIndex("approval_records_dispute_action_approved_idx")
      .on(t.disputeId, t.actionType)
      .where(sql`${t.decision} = 'approved'`),
  ],
);

// ---------------------------------------------------------------------------
// 3.6 action_executions
// ---------------------------------------------------------------------------
export const actionExecutions = pgTable("action_executions", {
  id: pk(),
  approvalRecordId: uuid("approval_record_id")
    .notNull()
    .unique()
    .references(() => approvalRecords.id),
  disputeId: uuid("dispute_id")
    .notNull()
    .references(() => disputes.id),
  actionType: text("action_type", { enum: ACTION_TYPES }).notNull(),
  /** Payload sent (or that would be sent) to PayPal. */
  approvedPayload: jsonb("approved_payload").$type<JsonObject>().notNull(),
  originalDraft: text("original_draft"),
  /** Merchant-edited version; null if not edited. */
  editedDraft: text("edited_draft"),
  /** Sent as the PayPal-Request-Id header; reused unchanged on retry. */
  paypalRequestId: uuid("paypal_request_id").notNull(),
  /** Set on success; null if pending or failed. */
  paypalResponse: jsonb("paypal_response").$type<JsonObject>(),
  /** Set on success or simulation. */
  executedAt: text("executed_at"),
  isSimulated: boolean("is_simulated").notNull().default(false),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 3.7 agent_activity
// ---------------------------------------------------------------------------
export const agentActivity = pgTable("agent_activity", {
  id: pk(),
  refOrderId: uuid("ref_order_id").references(() => orders.id),
  refDisputeId: uuid("ref_dispute_id").references(() => disputes.id),
  sessionId: text("session_id"),
  stepType: text("step_type", { enum: ACTIVITY_STEP_TYPES }).notNull(),
  toolName: text("tool_name").notNull(),
  /** PII-scrubbed. */
  inputSummary: text("input_summary").notNull(),
  outputSummary: text("output_summary").notNull(),
  durationMs: integer("duration_ms").notNull(),
  status: text("status", { enum: ACTIVITY_STATUSES }).notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 3.8 signal_weights (one active row; a pending proposal lives in the proposed_* columns)
// ---------------------------------------------------------------------------
export const signalWeights = pgTable("signal_weights", {
  id: pk(),
  countryMismatch: integer("country_mismatch").notNull().default(20),
  firstTimeHighValue: integer("first_time_high_value").notNull().default(20),
  rushShipping: integer("rush_shipping").notNull().default(15),
  highRelativeValue: integer("high_relative_value").notNull().default(20),
  disposableEmail: integer("disposable_email").notNull().default(15),
  repeatedAttempts: integer("repeated_attempts").notNull().default(10),
  isActive: boolean("is_active").notNull().default(true),
  resolvedSinceLastProposal: integer("resolved_since_last_proposal").notNull().default(0),
  proposedCountryMismatch: integer("proposed_country_mismatch"),
  proposedFirstTimeHighValue: integer("proposed_first_time_high_value"),
  proposedRushShipping: integer("proposed_rush_shipping"),
  proposedHighRelativeValue: integer("proposed_high_relative_value"),
  proposedDisposableEmail: integer("proposed_disposable_email"),
  proposedRepeatedAttempts: integer("proposed_repeated_attempts"),
  proposalReasoning: text("proposal_reasoning"),
  proposalCreatedAt: text("proposal_created_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// 3.9 dispute_outcomes
// ---------------------------------------------------------------------------
export const disputeOutcomes = pgTable("dispute_outcomes", {
  id: pk(),
  disputeId: uuid("dispute_id")
    .notNull()
    .unique()
    .references(() => disputes.id),
  outcome: text("outcome", { enum: DISPUTE_OUTCOMES }).notNull(),
  riskScoreSnapshot: integer("risk_score_snapshot").notNull(),
  verdictSnapshot: text("verdict_snapshot", { enum: VERDICTS }).notNull(),
  winProbabilitySnapshot: num("win_probability_snapshot").notNull(),
  signalWeightsId: uuid("signal_weights_id").references(() => signalWeights.id),
  isSimulated: boolean("is_simulated").notNull().default(false),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// 3.10 llm_rate_limits (per-session rolling hourly window)
// ---------------------------------------------------------------------------
export const llmRateLimits = pgTable("llm_rate_limits", {
  sessionId: text("session_id").primaryKey(),
  callCount: integer("call_count").notNull().default(0),
  /** ISO-8601; the window resets when now() > window_start + 1 hour. */
  windowStart: text("window_start").notNull(),
});

// ---------------------------------------------------------------------------
// 3.11 llm_daily_usage (global daily counter)
// ---------------------------------------------------------------------------
export const llmDailyUsage = pgTable("llm_daily_usage", {
  /** 'YYYY-MM-DD' (UTC) */
  day: text("day").primaryKey(),
  callCount: integer("call_count").notNull().default(0),
});

// ---------------------------------------------------------------------------
// 3.12 insights_cache (single row)
// ---------------------------------------------------------------------------
export const insightsCache = pgTable("insights_cache", {
  id: pk(),
  summary: text("summary"),
  usedFallback: boolean("used_fallback").notNull().default(false),
  /** SHA-256 of (outcome count + latest outcome id + proposal_created_at + active weights). */
  inputFingerprint: text("input_fingerprint").notNull(),
  generatedAt: text("generated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
export type EvidenceArtefact = typeof evidenceArtefacts.$inferSelect;
export type NewEvidenceArtefact = typeof evidenceArtefacts.$inferInsert;
export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
export type ApprovalRecord = typeof approvalRecords.$inferSelect;
export type NewApprovalRecord = typeof approvalRecords.$inferInsert;
export type ActionExecution = typeof actionExecutions.$inferSelect;
export type NewActionExecution = typeof actionExecutions.$inferInsert;
export type AgentActivityRow = typeof agentActivity.$inferSelect;
export type NewAgentActivityRow = typeof agentActivity.$inferInsert;
export type SignalWeights = typeof signalWeights.$inferSelect;
export type NewSignalWeights = typeof signalWeights.$inferInsert;
export type DisputeOutcome = typeof disputeOutcomes.$inferSelect;
export type NewDisputeOutcome = typeof disputeOutcomes.$inferInsert;
export type InsightsCacheRow = typeof insightsCache.$inferSelect;
export type NewInsightsCacheRow = typeof insightsCache.$inferInsert;
