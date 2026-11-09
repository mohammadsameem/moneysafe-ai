/**
 * Error types for the LLM layer. None of them carry API keys, request bodies or provider
 * response bodies, so they are safe to log.
 */

/** No provider is configured (LLM_API_KEY is empty). No network call was made. */
export class LlmNotConfiguredError extends Error {
  constructor() {
    super("No LLM provider is configured (LLM_API_KEY is empty)");
    this.name = "LlmNotConfiguredError";
  }
}

/** A provider could not give a usable response: HTTP error, network failure, timeout, or empty reply. */
export class LlmProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: "http" | "network" | "timeout" | "bad_response",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/**
 * The model answered but the answer is unusable: not JSON, or it failed the zod schema.
 * Another provider is NOT tried for this; the caller uses its rule-based result (REQ-NFR-02).
 */
export class LlmValidationError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "LlmValidationError";
  }
}

/** Every configured provider failed. */
export class LlmUnavailableError extends Error {
  constructor(readonly failures: readonly LlmProviderError[]) {
    super(`All LLM providers failed: ${failures.map((f) => `${f.provider} (${f.message})`).join(", ")}`);
    this.name = "LlmUnavailableError";
  }
}
