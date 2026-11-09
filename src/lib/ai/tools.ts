/**
 * Tool definitions sent to the model (design 5.4). `parameters` is JSON Schema, kept in step with
 * the zod schemas in schemas.ts: same property names, same required list, same length limits
 * (a test checks this).
 *
 * Only `type`, `description`, `properties`, `required` and `maxLength` are used. Gemini's OpenAI
 * compatibility layer accepts an OpenAPI-style subset of JSON Schema, so keywords outside that
 * subset (such as `additionalProperties`) are left out; zod ignores unknown keys anyway.
 */
import {
  RISK_EXPLANATION_MAX_CHARS,
  RISK_EXPLANATION_MAX_WORDS,
  VERIFICATION_BODY_MAX_CHARS,
  VERIFICATION_BODY_MAX_WORDS,
  VERIFICATION_SUBJECT_MAX_CHARS,
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
