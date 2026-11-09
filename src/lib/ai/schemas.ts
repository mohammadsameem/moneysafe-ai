/**
 * zod schemas for what the model may return (design 5.4). Every model answer is validated with
 * one of these before the app uses it; raw model text is never trusted.
 *
 * The limits are shared constants, also used by the JSON-schema `parameters` in tools.ts, so the
 * two cannot drift apart.
 */
import { z } from "zod";

export const RISK_EXPLANATION_MAX_CHARS = 600;
/** REQ-ORD-05: the explanation is at most 120 words. */
export const RISK_EXPLANATION_MAX_WORDS = 120;
export const VERIFICATION_SUBJECT_MAX_CHARS = 100;
export const VERIFICATION_BODY_MAX_CHARS = 1000;
/** REQ-ORD-06: the verification message is at most 200 words. */
export const VERIFICATION_BODY_MAX_WORDS = 200;

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

// risk_explanation
export const RiskExplanationSchema = z.object({
  explanation: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(RISK_EXPLANATION_MAX_CHARS)
    .refine((text) => countWords(text) <= RISK_EXPLANATION_MAX_WORDS, `must be at most ${RISK_EXPLANATION_MAX_WORDS} words`),
});
export type RiskExplanation = z.infer<typeof RiskExplanationSchema>;

// verification_draft
export const VerificationDraftSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(VERIFICATION_SUBJECT_MAX_CHARS)
    .refine((text) => !/[\r\n]/.test(text), "must be a single line"),
  body: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(VERIFICATION_BODY_MAX_CHARS)
    .refine((text) => countWords(text) <= VERIFICATION_BODY_MAX_WORDS, `must be at most ${VERIFICATION_BODY_MAX_WORDS} words`),
});
export type VerificationDraftResult = z.infer<typeof VerificationDraftSchema>;

// ---------------------------------------------------------------------------
// dispute_analysis (design 5.4). The model returns an adjustment and an explanation; the SYSTEM
// clamps the adjustment to [-0.1, +0.1] and owns every final number.
// ---------------------------------------------------------------------------
export const DISPUTE_REASONING_MAX_CHARS = 1200;
/** REQ-DIS-03: reasoning is at most 200 words. */
export const DISPUTE_REASONING_MAX_WORDS = 200;
export const EVIDENCE_LIST_MAX_ITEMS = 12;
export const EVIDENCE_ITEM_MAX_CHARS = 160;
/** The zod schema accepts a wider range than the tool asks for; the system clamps to +/-0.1. */
export const LLM_ADJUSTMENT_SCHEMA_LIMIT = 0.5;

const evidenceList = z.array(z.string().trim().min(1).max(EVIDENCE_ITEM_MAX_CHARS)).max(EVIDENCE_LIST_MAX_ITEMS);

export const DisputeAnalysisSchema = z.object({
  llm_adjustment: z.number().min(-LLM_ADJUSTMENT_SCHEMA_LIMIT).max(LLM_ADJUSTMENT_SCHEMA_LIMIT),
  reasoning: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(DISPUTE_REASONING_MAX_CHARS)
    .refine((text) => countWords(text) <= DISPUTE_REASONING_MAX_WORDS, `must be at most ${DISPUTE_REASONING_MAX_WORDS} words`),
  /** Absent or null means "no override". */
  override_recommendation: z
    .enum(["contest", "refund"])
    .nullish()
    .transform((v) => v ?? null),
  evidence_used: evidenceList,
  evidence_gaps: evidenceList,
});
export type DisputeAnalysis = z.infer<typeof DisputeAnalysisSchema>;

// ---------------------------------------------------------------------------
// dispute_draft_response
// ---------------------------------------------------------------------------
export const DRAFT_RESPONSE_MAX_CHARS = 2400;
/** REQ-DIS-04: the draft response is at most 400 words. */
export const DRAFT_RESPONSE_MAX_WORDS = 400;

export const DraftResponseSchema = z.object({
  response_text: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(DRAFT_RESPONSE_MAX_CHARS)
    .refine((text) => countWords(text) <= DRAFT_RESPONSE_MAX_WORDS, `must be at most ${DRAFT_RESPONSE_MAX_WORDS} words`),
});
export type DraftResponse = z.infer<typeof DraftResponseSchema>;

// ---------------------------------------------------------------------------
// weight_proposal (design 5.4, REQ-LL-02). The model proposes six whole-number weights and says
// why; the SYSTEM then caps each change to +/-3 and keeps every weight in [5, 30]. The schema
// accepts a wider range (1-40) than the final result, exactly as the design specifies.
// ---------------------------------------------------------------------------
export const WEIGHT_PROPOSAL_REASONING_MAX_CHARS = 900;
export const WEIGHT_PROPOSAL_REASONING_MAX_WORDS = 150;
const proposedWeight = z.number().int().min(1).max(40);

export const WeightProposalSchema = z.object({
  proposed_weights: z.object({
    country_mismatch: proposedWeight,
    first_time_high_value: proposedWeight,
    rush_shipping: proposedWeight,
    high_relative_value: proposedWeight,
    disposable_email: proposedWeight,
    repeated_attempts: proposedWeight,
  }),
  reasoning: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(WEIGHT_PROPOSAL_REASONING_MAX_CHARS)
    .refine((text) => countWords(text) <= WEIGHT_PROPOSAL_REASONING_MAX_WORDS, `must be at most ${WEIGHT_PROPOSAL_REASONING_MAX_WORDS} words`),
});
export type WeightProposal = z.infer<typeof WeightProposalSchema>;

// ---------------------------------------------------------------------------
// insights_summary (REQ-LL-03): at most 150 words.
// ---------------------------------------------------------------------------
export const INSIGHTS_SUMMARY_MAX_CHARS = 900;
export const INSIGHTS_SUMMARY_MAX_WORDS = 150;

export const InsightsSummarySchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(INSIGHTS_SUMMARY_MAX_CHARS)
    .refine((text) => countWords(text) <= INSIGHTS_SUMMARY_MAX_WORDS, `must be at most ${INSIGHTS_SUMMARY_MAX_WORDS} words`),
});
export type InsightsSummary = z.infer<typeof InsightsSummarySchema>;
