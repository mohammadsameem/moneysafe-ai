import { z } from "zod";

/** "true"/"false" strings from process.env -> boolean. Unset or empty -> default. */
const boolFromString = (defaultValue: boolean) =>
  z
    .enum(["true", "false", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? defaultValue : v === "true"));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

/** Unset or blank -> the default; otherwise the trimmed value. */
const stringWithDefault = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : fallback));

// ---------------------------------------------------------------------------
// LLM provider defaults. Any OpenAI-compatible chat-completions API works; these are the
// free-tier defaults, checked against each provider's own documentation on 2026-11-08.
// ---------------------------------------------------------------------------
/** Gemini's OpenAI-compatible endpoint (https://ai.google.dev/gemini-api/docs/openai). */
export const DEFAULT_LLM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
/** A current Flash model that is free of charge on the Gemini API free tier. */
export const DEFAULT_LLM_MODEL = "gemini-3.8-flash";
/** Groq's OpenAI-compatible endpoint (https://console.groq.com/docs/openai). */
export const DEFAULT_LLM_FALLBACK_BASE_URL = "https://api.groq.com/openai/v1";
/** Groq lists this model with local tool use and JSON mode support. */
export const DEFAULT_LLM_FALLBACK_MODEL = "openai/gpt-oss-120b";
/** Global cap on LLM calls per UTC day. Keep it under the provider's own daily limit. */
export const DEFAULT_LLM_DAILY_CAP = 200;

const llmUrl = (name: string, fallback: string) =>
  stringWithDefault(fallback).pipe(z.string().url(`${name} must be a full URL`));

/**
 * LLM settings. Everything is optional: with no LLM_API_KEY the app never calls a model and
 * every AI feature uses its rule-based result.
 */
const llmEnvSchema = z.object({
  LLM_API_KEY: optionalString,
  LLM_BASE_URL: llmUrl("LLM_BASE_URL", DEFAULT_LLM_BASE_URL),
  LLM_MODEL: stringWithDefault(DEFAULT_LLM_MODEL),
  // Optional second provider, tried once if the first errors or returns 429.
  LLM_FALLBACK_API_KEY: optionalString,
  LLM_FALLBACK_BASE_URL: llmUrl("LLM_FALLBACK_BASE_URL", DEFAULT_LLM_FALLBACK_BASE_URL),
  LLM_FALLBACK_MODEL: stringWithDefault(DEFAULT_LLM_FALLBACK_MODEL),
  LLM_DAILY_CAP: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().default(DEFAULT_LLM_DAILY_CAP),
  ),
});

export type LlmEnv = z.infer<typeof llmEnvSchema>;

const envSchema = z
  .object({
    // Database. Runtime uses the pooled URL; DIRECT_URL (port 5432) is only for drizzle-kit migrations.
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DIRECT_URL: optionalString,

    // PayPal sandbox. Optional: if absent or failing, reads fall back to seeded data (REQ-DEMO-01).
    PAYPAL_CLIENT_ID: optionalString,
    PAYPAL_CLIENT_SECRET: optionalString,

    // Behaviour flags and cost assumptions.
    DEMO_MODE: boolFromString(false),
    CHARGEBACK_FEE_USD: z.coerce.number().nonnegative().default(20),
    CONTEST_EFFORT_USD: z.coerce.number().nonnegative().default(10),

    // Auth (single-merchant demo login).
    DEMO_PASSWORD: z.string().min(1, "DEMO_PASSWORD is required"),
    NEXTAUTH_SECRET: z.string().min(16, "NEXTAUTH_SECRET must be at least 16 characters"),
    NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a full URL"),
  })
  .merge(llmEnvSchema);

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

function describeIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/**
 * Read and validate environment variables once.
 * Lazy on purpose: importing this module never throws, so `next build` works without secrets.
 * The first call at runtime throws a single readable error listing every problem.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${describeIssues(parsed.error.issues)}\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Just the LLM settings, with defaults applied. Separate from getEnv() so the AI layer and its
 * tests don't need database or auth variables. `source` defaults to process.env.
 */
export function getLlmEnv(source: Record<string, string | undefined> = process.env): LlmEnv {
  const parsed = llmEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid LLM configuration:\n${describeIssues(parsed.error.issues)}\nSee .env.example.`);
  }
  return parsed.data;
}

/**
 * PayPal sandbox credentials, or null when either is missing (the app then uses seeded data and
 * simulated writes, REQ-DEMO-01). Never throws.
 */
export function getPayPalCredentials(
  source: Record<string, string | undefined> = process.env,
): { clientId: string; clientSecret: string } | null {
  const clientId = source.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = source.PAYPAL_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * The app's public origin (NEXTAUTH_URL without any path or trailing slash). Used to build the
 * absolute return/cancel URLs PayPal redirects the buyer to. Throws without echoing the value.
 */
export function getAppBaseUrl(source: Record<string, string | undefined> = process.env): string {
  const parsed = z.string().url().safeParse(source.NEXTAUTH_URL?.trim());
  if (!parsed.success) throw new Error("NEXTAUTH_URL must be set to the app's full URL. See .env.example.");
  return new URL(parsed.data).origin;
}

/** True only when DEMO_MODE is exactly "true". */
export function isDemoModeEnabled(source: Record<string, string | undefined> = process.env): boolean {
  return source.DEMO_MODE?.trim().toLowerCase() === "true";
}

/**
 * Just the runtime database URL (the pooled connection string).
 * Separate from getEnv() so DB scripts (seed, db:check) don't need auth secrets to be set.
 */
export function getDatabaseUrl(): string {
  const parsed = z
    .string({ required_error: "DATABASE_URL is not set" })
    .min(1, "DATABASE_URL is empty")
    .url("DATABASE_URL must be a postgres:// connection string")
    .safeParse(process.env.DATABASE_URL);
  if (!parsed.success) {
    throw new Error(`Invalid DATABASE_URL: ${parsed.error.issues[0]?.message}. See .env.example.`);
  }
  return parsed.data;
}

/** Test helper: clear the memoised value so a test can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
