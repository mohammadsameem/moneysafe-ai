/**
 * Live smoke test for the configured LLM providers (npm run llm:check).
 *
 * Makes ONE tiny structured call through each provider on its own (not through the
 * primary-then-fallback chain) using the real pinned-tool path, with a trivial zod schema, and
 * reports whether the provider accepted the pinned tool_choice or the JSON retry was needed.
 *
 * Output safety: results contain only the provider label, model id, HTTP status codes, the
 * pinned/JSON-retry classification, pass/fail, and a short reason (at most 80 characters). They
 * never contain API keys, base URLs (so no query strings), prompts or response bodies.
 */
import { z } from "zod";
import type { LlmEnv } from "../env";
import { callStructured, type LlmAttempt, type StructuredTool } from "./structured";
import { providerLabel, type LlmProvider } from "./providers";

export const SMOKE_TOOL: StructuredTool = {
  name: "ping",
  description: "Report that the connection works.",
  parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};
export const SMOKE_SCHEMA = z.object({ ok: z.literal(true) });
export const SMOKE_PROMPT =
  "<instructions>Call the ping tool with ok set to true.</instructions>\n<data>connectivity check</data>";

export const EXCERPT_MAX = 80;

/** At most `max` characters, single line. */
export function excerpt(text: string, max = EXCERPT_MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

export interface SmokeTarget {
  role: "primary" | "fallback";
  label: string;
  model: string;
  baseUrl: string;
  /** Undefined or empty means the provider is skipped. */
  apiKey: string | undefined;
  /** The env var that holds this provider's key, for the skip message. */
  keyVar: "LLM_API_KEY" | "LLM_FALLBACK_API_KEY";
}

/** Both providers, whether or not their keys are set. Each is tested independently. */
export function smokeTargets(env: LlmEnv): SmokeTarget[] {
  return [
    {
      role: "primary",
      label: providerLabel(env.LLM_BASE_URL),
      model: env.LLM_MODEL,
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      keyVar: "LLM_API_KEY",
    },
    {
      role: "fallback",
      label: providerLabel(env.LLM_FALLBACK_BASE_URL),
      model: env.LLM_FALLBACK_MODEL,
      baseUrl: env.LLM_FALLBACK_BASE_URL,
      apiKey: env.LLM_FALLBACK_API_KEY,
      keyVar: "LLM_FALLBACK_API_KEY",
    },
  ];
}

/** How the provider treated `tool_choice: { type: "function", function: { name } }`. */
export type PinnedOutcome =
  | "accepted" // returned the pinned tool call
  | "ignored" // accepted the parameter but answered in message text instead of calling the tool
  | "rejected" // HTTP 400/422: the JSON-only retry was needed
  | "unknown"; // the request failed for another reason, so this was not determined

export interface SmokeResult {
  role: SmokeTarget["role"];
  label: string;
  model: string;
  status: "pass" | "fail" | "skipped";
  /** Last HTTP status observed; undefined if no response arrived (or skipped). */
  httpStatus?: number;
  /** Status of the rejected pinned request, when pinned === "rejected". */
  rejectedStatus?: number;
  pinned?: PinnedOutcome;
  jsonRetryUsed?: boolean;
  /** Short reason for a failure or a skip. At most 80 characters. */
  detail?: string;
}

export async function runSmoke(target: SmokeTarget, fetchImpl: typeof fetch = fetch): Promise<SmokeResult> {
  const base = { role: target.role, label: target.label, model: target.model };
  if (!target.apiKey) {
    return { ...base, status: "skipped", detail: excerpt(`${target.keyVar} is empty`) };
  }

  const provider: LlmProvider = {
    role: target.role,
    label: target.label,
    baseUrl: target.baseUrl,
    model: target.model,
    apiKey: target.apiKey,
  };

  // Record every HTTP status so the report can show the real code, including on the rejected request.
  const statuses: number[] = [];
  const recordingFetch: typeof fetch = async (...args) => {
    const response = await fetchImpl(...args);
    statuses.push(response.status);
    return response;
  };
  const attempts: LlmAttempt[] = [];

  let failure: unknown;
  try {
    await callStructured({
      providers: [provider], // this provider only: no fallback chain
      tool: SMOKE_TOOL,
      schema: SMOKE_SCHEMA,
      prompt: SMOKE_PROMPT,
      maxTokens: 1024,
      fetchImpl: recordingFetch,
      onAttempt: (a) => void attempts.push(a),
    });
  } catch (err) {
    failure = err;
  }

  const toolAttempt = attempts.find((a) => a.mode === "tool");
  const jsonAttempt = attempts.find((a) => a.mode === "json");
  let pinned: PinnedOutcome = "unknown";
  let rejectedStatus: number | undefined;
  if (toolAttempt?.outcome === "success") {
    pinned = toolAttempt.via === "content" ? "ignored" : "accepted";
  } else if (toolAttempt && /^HTTP (400|422)$/.test(toolAttempt.detail)) {
    pinned = "rejected";
    rejectedStatus = Number(toolAttempt.detail.slice(5));
  }

  const result: SmokeResult = {
    ...base,
    status: failure ? "fail" : "pass",
    httpStatus: statuses.length > 0 ? statuses[statuses.length - 1] : undefined,
    pinned,
    jsonRetryUsed: jsonAttempt !== undefined,
    ...(rejectedStatus !== undefined ? { rejectedStatus } : {}),
  };
  if (failure) {
    const message = failure instanceof Error ? failure.message : "unexpected error";
    result.detail = excerpt(message);
  }
  return result;
}

const PINNED_TEXT: Record<PinnedOutcome, string> = {
  accepted: "pinned tool_choice: ACCEPTED",
  ignored: "pinned tool_choice: accepted but answered in text",
  rejected: "pinned tool_choice: REJECTED",
  unknown: "pinned tool_choice: not determined",
};

/** One printable line. Contains no keys, URLs or response bodies. */
export function formatSmokeLine(r: SmokeResult): string {
  const who = `${r.role.toUpperCase().padEnd(8)} ${r.label.padEnd(10)} ${r.model}`;
  if (r.status === "skipped") return `${who}  SKIPPED (${r.detail})`;

  const http = r.httpStatus !== undefined ? `HTTP ${r.httpStatus}` : "no HTTP response";
  const pinned =
    r.pinned === "rejected" && r.rejectedStatus !== undefined
      ? `${PINNED_TEXT.rejected} (HTTP ${r.rejectedStatus})`
      : PINNED_TEXT[r.pinned ?? "unknown"];
  const retry = `JSON retry: ${r.jsonRetryUsed ? "used" : "not needed"}`;
  const verdict = r.status === "pass" ? "PASS" : `FAIL (${r.detail})`;
  return `${who}  ${http}  ${pinned}  ${retry}  ${verdict}`;
}
