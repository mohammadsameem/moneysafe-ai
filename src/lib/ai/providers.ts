/**
 * LLM provider configuration. Any OpenAI-compatible chat-completions API works.
 */
import { getLlmEnv, type LlmEnv } from "../env";

export interface LlmProvider {
  role: "primary" | "fallback";
  /** Short name used in logs and agent_activity, e.g. "gemini". Never contains the key. */
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const KNOWN_HOSTS: Record<string, string> = {
  "generativelanguage.googleapis.com": "gemini",
  "api.groq.com": "groq",
  "openrouter.ai": "openrouter",
  "api.openai.com": "openai",
  "api.mistral.ai": "mistral",
  "api.together.xyz": "together",
};

/** A readable provider name for logs, derived from the base URL's host. */
export function providerLabel(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return KNOWN_HOSTS[host] ?? host;
  } catch {
    return "unknown";
  }
}

/**
 * The providers to try, in order. LLM_API_KEY is the master switch: when it is empty the list
 * is empty and no model is ever called, even if a fallback key is set.
 */
export function buildProviders(env: LlmEnv): LlmProvider[] {
  if (!env.LLM_API_KEY) return [];
  const providers: LlmProvider[] = [
    {
      role: "primary",
      label: providerLabel(env.LLM_BASE_URL),
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      apiKey: env.LLM_API_KEY,
    },
  ];
  if (env.LLM_FALLBACK_API_KEY) {
    providers.push({
      role: "fallback",
      label: providerLabel(env.LLM_FALLBACK_BASE_URL),
      baseUrl: env.LLM_FALLBACK_BASE_URL,
      model: env.LLM_FALLBACK_MODEL,
      apiKey: env.LLM_FALLBACK_API_KEY,
    });
  }
  return providers;
}

let warned = false;

/**
 * Providers from the process environment. A malformed LLM setting (for example a bad base URL)
 * disables the LLM with a one-time warning instead of crashing the app; the warning names the
 * variable but never prints its value.
 */
export function getConfiguredProviders(): LlmProvider[] {
  try {
    return buildProviders(getLlmEnv());
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[llm] LLM disabled: ${err instanceof Error ? err.message : "invalid configuration"}`);
    }
    return [];
  }
}
