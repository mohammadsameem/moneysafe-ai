/**
 * Minimal OpenAI-compatible chat-completions client over plain fetch.
 *   POST {baseUrl}/chat/completions   Authorization: Bearer <key>
 *
 * Errors never include the response body (providers sometimes echo parts of the key in 401s).
 */
import { LlmProviderError } from "./errors";
import { LLM_PROVIDER_TIMEOUT_MS, type LlmProvider } from "./providers";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { type?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }[];
    };
  }[];
}

export const DEFAULT_TIMEOUT_MS = LLM_PROVIDER_TIMEOUT_MS;

/**
 * `{baseUrl}/chat/completions`, appended to the URL's path so that a query string on the base
 * URL (for example `?api-version=...`) stays at the end where it belongs.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url.toString();
}

export interface PostOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function postChatCompletion(
  provider: LlmProvider,
  request: ChatCompletionRequest,
  options: PostOptions = {},
): Promise<ChatCompletionResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = chatCompletionsUrl(provider.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    throw new LlmProviderError(provider.label, aborted ? "timeout" : "network", aborted ? "timeout" : "network error");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await response.text().catch(() => undefined); // release the connection; the body is deliberately unused
    throw new LlmProviderError(provider.label, "http", `HTTP ${response.status}`, response.status);
  }

  try {
    return (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new LlmProviderError(provider.label, "bad_response", "response was not JSON");
  }
}
