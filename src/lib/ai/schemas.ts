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
