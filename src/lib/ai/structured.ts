/**
 * Structured LLM output over an OpenAI-compatible chat-completions API.
 *
 * Per provider:
 *   1. Function calling with the tool pinned by name:
 *        tool_choice: { type: "function", function: { name } }
 *   2. If the provider rejects that request (HTTP 400/422), retry ONCE on the same provider with
 *      JSON-only instructions and parse JSON from the message.
 *   3. In every case the result is validated with the caller's zod schema. Raw model text is
 *      never trusted.
 *
 * Provider chain: the primary provider is tried first; if it errors, times out or returns 429/5xx
 * the fallback provider is tried once. If both fail, LlmUnavailableError is thrown and the caller
 * uses its rule-based result. A model answer that fails validation is NOT retried elsewhere.
 *
 * Untrusted-input isolation: `prompt` is passed through byte-for-byte as the user message, in both
 * the tool attempt and the JSON retry. Its <instructions>/<data> structure (built by the prompt
 * builders) is never altered. The JSON-only instruction is a separate, static system message.
 */
import type { z } from "zod";
import {
  postChatCompletion,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
} from "./chat-completions";
import {
  LlmNotConfiguredError,
  LlmProviderError,
  LlmUnavailableError,
  LlmValidationError,
} from "./errors";
import type { LlmProvider } from "./providers";

export interface StructuredTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments; keep it in step with the zod schema. */
  parameters: Record<string, unknown>;
}

export type AttemptMode = "tool" | "json";

/** One request to one provider. Contains no keys, prompts or response bodies. */
export interface LlmAttempt {
  provider: string;
  role: "primary" | "fallback";
  model: string;
  mode: AttemptMode;
  outcome: "success" | "error";
  durationMs: number;
  /** "ok", "HTTP 429", "timeout", "network error", "validation failed", ... */
  detail: string;
  /**
   * On success: "tool_call" when the provider returned the pinned tool call, "content" when it
   * answered in message text instead (JSON retry, or a provider that ignored tool_choice).
   */
  via?: "tool_call" | "content";
}

export interface StructuredOptions<T> {
  /** Providers in order (primary first). Empty means "not configured". */
  providers: readonly LlmProvider[];
  tool: StructuredTool;
  /** The input type is unconstrained so schemas with `.transform()` / `.default()` are accepted. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** The full user message, already built with <instructions> / <data> separation. */
  prompt: string;
  /** Optional static system message. */
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Called after every request. Failures inside the hook are swallowed. */
  onAttempt?: (attempt: LlmAttempt) => void | Promise<void>;
}

export interface StructuredResult<T> {
  data: T;
  provider: string;
  mode: AttemptMode;
}

const DEFAULT_MAX_TOKENS = 2048;

export async function callStructured<T>(options: StructuredOptions<T>): Promise<StructuredResult<T>> {
  if (options.providers.length === 0) throw new LlmNotConfiguredError();

  const failures: LlmProviderError[] = [];
  for (const provider of options.providers) {
    try {
      return await runOnProvider(provider, options);
    } catch (err) {
      if (err instanceof LlmProviderError) {
        failures.push(err);
        continue; // try the next provider
      }
      throw err; // LlmValidationError and anything unexpected stop the chain
    }
  }
  throw new LlmUnavailableError(failures);
}

async function runOnProvider<T>(provider: LlmProvider, options: StructuredOptions<T>): Promise<StructuredResult<T>> {
  try {
    return await attempt(provider, options, "tool");
  } catch (err) {
    // Only a 400/422 means "this provider refused the pinned tool_choice". Rate limits, outages,
    // auth errors and timeouts go straight to the next provider.
    const rejected =
      err instanceof LlmProviderError && err.kind === "http" && (err.status === 400 || err.status === 422);
    if (!rejected) throw err;
    return await attempt(provider, options, "json");
  }
}

async function attempt<T>(
  provider: LlmProvider,
  options: StructuredOptions<T>,
  mode: AttemptMode,
): Promise<StructuredResult<T>> {
  const started = Date.now();
  const report = async (outcome: LlmAttempt["outcome"], detail: string, via?: LlmAttempt["via"]) => {
    try {
      await options.onAttempt?.({
        provider: provider.label,
        role: provider.role,
        model: provider.model,
        mode,
        outcome,
        durationMs: Date.now() - started,
        detail,
        ...(via ? { via } : {}),
      });
    } catch {
      /* logging must never break the call */
    }
  };

  try {
    const response = await postChatCompletion(provider, buildRequest(provider, options, mode), {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    const { data, via } = readStructured(response, provider, options);
    await report("success", "ok", via);
    return { data, provider: provider.label, mode };
  } catch (err) {
    await report("error", describe(err));
    throw err;
  }
}

function buildRequest<T>(provider: LlmProvider, options: StructuredOptions<T>, mode: AttemptMode): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });

  const base = {
    model: provider.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };

  if (mode === "tool") {
    messages.push({ role: "user", content: options.prompt });
    return {
      ...base,
      messages,
      tools: [
        {
          type: "function",
          function: {
            name: options.tool.name,
            description: options.tool.description,
            parameters: options.tool.parameters,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: options.tool.name } },
    };
  }

  // JSON-only retry: no tools. The instruction is its own static system message; the user message
  // (and the <data> section inside it) is exactly what the tool attempt sent.
  messages.push({
    role: "system",
    content:
      "Respond with ONLY a single JSON object that matches the JSON Schema below. " +
      "Do not add commentary, markdown or code fences.\n" +
      `JSON Schema: ${JSON.stringify(options.tool.parameters)}`,
  });
  messages.push({ role: "user", content: options.prompt });
  return { ...base, messages };
}

/** Pull the structured answer out of a response and validate it. Never trusts raw text. */
function readStructured<T>(
  response: ChatCompletionResponse,
  provider: LlmProvider,
  options: StructuredOptions<T>,
): { data: T; via: "tool_call" | "content" } {
  const message = response.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.find((c) => c.function?.name === options.tool.name);
  const args = toolCall?.function?.arguments;

  let raw: unknown;
  let via: "tool_call" | "content";
  if (args !== undefined) {
    raw = typeof args === "string" ? parseJson(args, provider) : args;
    via = "tool_call";
  } else if (typeof message?.content === "string" && message.content.trim() !== "") {
    // JSON retry, or a provider that ignored tool_choice and answered in text.
    raw = parseJson(message.content, provider);
    via = "content";
  } else {
    throw new LlmProviderError(provider.label, "bad_response", "response had no tool call or content");
  }

  const result = options.schema.safeParse(raw);
  if (!result.success) {
    const where = Array.from(new Set(result.error.issues.map((i) => i.path.join(".") || "(root)"))).join(", ");
    throw new LlmValidationError(provider.label, `response failed schema validation at: ${where}`);
  }
  return { data: result.data, via };
}

function parseJson(text: string, provider: LlmProvider): unknown {
  try {
    return extractJson(text);
  } catch {
    throw new LlmValidationError(provider.label, "response was not valid JSON");
  }
}

/** Parse JSON, tolerating a ```json fence or a sentence around the object. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) throw new SyntaxError("no JSON object found");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

function describe(err: unknown): string {
  if (err instanceof LlmProviderError) return err.message;
  if (err instanceof LlmValidationError) return "validation failed";
  return "unexpected error";
}
