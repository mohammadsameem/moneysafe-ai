/**
 * Tool definitions sent to the model (design 5.4). `parameters` is JSON Schema, kept in step with
 * the zod schemas in schemas.ts: same property names, same required list, same length limits
 * (a test checks this).
 *
 * Only `type`, `description`, `properties`, `required`, `maxLength`, `items`, `enum`, `minimum`,
 * `maximum` and `maxItems` are used. Gemini's OpenAI compatibility layer accepts an OpenAPI-style
 * subset of JSON Schema, so keywords outside that subset (such as `additionalProperties`, or a
 * `["string","null"]` type) are left out; an optional value is simply not listed in `required`,
 * and zod ignores unknown keys anyway.
 */
import { LLM_ADJUSTMENT_LIMIT } from "@/lib/scoring";
import {
  DISPUTE_REASONING_MAX_CHARS,
  DISPUTE_REASONING_MAX_WORDS,
  DRAFT_RESPONSE_MAX_CHARS,
  DRAFT_RESPONSE_MAX_WORDS,
  EVIDENCE_ITEM_MAX_CHARS,
  EVIDENCE_LIST_MAX_ITEMS,
  INSIGHTS_SUMMARY_MAX_CHARS,
  INSIGHTS_SUMMARY_MAX_WORDS,
  RISK_EXPLANATION_MAX_CHARS,
  RISK_EXPLANATION_MAX_WORDS,
  VERIFICATION_BODY_MAX_CHARS,
  VERIFICATION_BODY_MAX_WORDS,
  VERIFICATION_SUBJECT_MAX_CHARS,
  WEIGHT_PROPOSAL_REASONING_MAX_CHARS,
  WEIGHT_PROPOSAL_REASONING_MAX_WORDS,
} from "./schemas";
import type { StructuredTool } from "./structured";

export const RISK_EXPLANATION_TOOL: StructuredTool = {
  name: "risk_explanation",
  description: "Return a plain-English explanation of why an order received its risk score.",
  parameters: {
    type: "object",
    properties: {
      explanation: {
        type: "string",
        description: `Plain-English explanation for a shop owner, at most ${RISK_EXPLANATION_MAX_WORDS} words.`,
        maxLength: RISK_EXPLANATION_MAX_CHARS,
      },
    },
    required: ["explanation"],
  },
};

export const VERIFICATION_DRAFT_TOOL: StructuredTool = {
  name: "verification_draft",
  description: "Return a polite message asking the buyer to confirm their order before it ships.",
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "Email subject on a single line.",
        maxLength: VERIFICATION_SUBJECT_MAX_CHARS,
      },
      body: {
        type: "string",
        description: `Email body, plain text, at most ${VERIFICATION_BODY_MAX_WORDS} words.`,
        maxLength: VERIFICATION_BODY_MAX_CHARS,
      },
    },
    required: ["subject", "body"],
  },
};

// ---------------------------------------------------------------------------
// Dispute tools. READ-ONLY by construction: each one only RETURNS text and numbers for the merchant
// to read. No tool here, or anywhere, can submit evidence, accept a claim or call PayPal; the model
// has no write tool at all (REQ-NFR-11).
// ---------------------------------------------------------------------------
export const DISPUTE_ANALYSIS_TOOL: StructuredTool = {
  name: "dispute_analysis",
  description: "Return a short assessment of a payment dispute: a small adjustment to the win likelihood, the reasoning, and the evidence used and missing.",
  parameters: {
    type: "object",
    properties: {
      llm_adjustment: {
        type: "number",
        description: `How much to move the base win likelihood, between -${LLM_ADJUSTMENT_LIMIT} and ${LLM_ADJUSTMENT_LIMIT}. Use 0 unless the evidence summary shows something the base figure cannot capture.`,
        minimum: -LLM_ADJUSTMENT_LIMIT,
        maximum: LLM_ADJUSTMENT_LIMIT,
      },
      reasoning: {
        type: "string",
        description: `Plain-English reasoning for a shop owner, at most ${DISPUTE_REASONING_MAX_WORDS} words. If you disagree with the system recommendation, say why.`,
        maxLength: DISPUTE_REASONING_MAX_CHARS,
      },
      override_recommendation: {
        type: "string",
        enum: ["contest", "refund"],
        description: "Only when you recommend the OPPOSITE of the system recommendation. Leave it out otherwise.",
      },
      evidence_used: {
        type: "array",
        description: "Short phrases naming the evidence that supports the merchant, taken from the evidence summary.",
        items: { type: "string", maxLength: EVIDENCE_ITEM_MAX_CHARS },
        maxItems: EVIDENCE_LIST_MAX_ITEMS,
      },
      evidence_gaps: {
        type: "array",
        description: "Short phrases naming evidence that is missing, taken from the evidence summary.",
        items: { type: "string", maxLength: EVIDENCE_ITEM_MAX_CHARS },
        maxItems: EVIDENCE_LIST_MAX_ITEMS,
      },
    },
    required: ["llm_adjustment", "reasoning", "evidence_used", "evidence_gaps"],
  },
};

export const DISPUTE_DRAFT_RESPONSE_TOOL: StructuredTool = {
  name: "dispute_draft_response",
  description: "Return a draft response from the merchant to PayPal's dispute team, citing the evidence on file.",
  parameters: {
    type: "object",
    properties: {
      response_text: {
        type: "string",
        description: `Plain-text response written as the merchant, at most ${DRAFT_RESPONSE_MAX_WORDS} words.`,
        maxLength: DRAFT_RESPONSE_MAX_CHARS,
      },
    },
    required: ["response_text"],
  },
};

// ---------------------------------------------------------------------------
// Learning-loop tools (M4-01). Also read-only: they return numbers and text. A proposal is only
// STORED as pending; nothing changes until the merchant approves it on the Insights page.
// ---------------------------------------------------------------------------
const weightProperty = (signal: string) => ({
  type: "integer",
  description: `New whole-number weight for ${signal}. Change it by at most 3 points from the current value, or leave it unchanged.`,
  minimum: 1,
  maximum: 40,
});

export const WEIGHT_PROPOSAL_TOOL: StructuredTool = {
  name: "weight_proposal",
  description: "Return proposed new weights for the six explainable risk signals, with the reasoning, based on recently resolved disputes.",
  parameters: {
    type: "object",
    properties: {
      proposed_weights: {
        type: "object",
        description: "One whole-number weight for each of the six signals. Repeat the current value for any signal you do not want to change.",
        properties: {
          country_mismatch: weightProperty("country_mismatch"),
          first_time_high_value: weightProperty("first_time_high_value"),
          rush_shipping: weightProperty("rush_shipping"),
          high_relative_value: weightProperty("high_relative_value"),
          disposable_email: weightProperty("disposable_email"),
          repeated_attempts: weightProperty("repeated_attempts"),
        },
        required: ["country_mismatch", "first_time_high_value", "rush_shipping", "high_relative_value", "disposable_email", "repeated_attempts"],
      },
      reasoning: {
        type: "string",
        description: `Plain-English reasoning for a shop owner, at most ${WEIGHT_PROPOSAL_REASONING_MAX_WORDS} words. Name each signal you changed and why, and say how small the sample is.`,
        maxLength: WEIGHT_PROPOSAL_REASONING_MAX_CHARS,
      },
    },
    required: ["proposed_weights", "reasoning"],
  },
};

export const INSIGHTS_SUMMARY_TOOL: StructuredTool = {
  name: "insights_summary",
  description: "Return a short plain-English summary of how resolved disputes are going and what the pending weight change (if any) means.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: `Plain-English summary for a shop owner, at most ${INSIGHTS_SUMMARY_MAX_WORDS} words.`,
        maxLength: INSIGHTS_SUMMARY_MAX_CHARS,
      },
    },
    required: ["summary"],
  },
};
