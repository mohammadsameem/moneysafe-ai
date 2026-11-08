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
  .transform((v) => (v && v.length > 0 ? v : undefined));

const envSchema = z.object({
  // Database. Runtime uses the pooled URL; DIRECT_URL (port 5432) is only for drizzle-kit migrations.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: optionalString,

  // PayPal sandbox. Optional: if absent or failing, reads fall back to seeded data (REQ-DEMO-01).
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,

  // Anthropic. Optional: if absent or failing, the app returns rule-based results (REQ-NFR-02).
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),

  // Behaviour flags and cost assumptions.
  DEMO_MODE: boolFromString(false),
  CHARGEBACK_FEE_USD: z.coerce.number().nonnegative().default(20),
  CONTEST_EFFORT_USD: z.coerce.number().nonnegative().default(10),
  LLM_DAILY_CAP: z.coerce.number().int().positive().default(300),

  // Auth (single-merchant demo login).
  DEMO_PASSWORD: z.string().min(1, "DEMO_PASSWORD is required"),
  NEXTAUTH_SECRET: z.string().min(16, "NEXTAUTH_SECRET must be at least 16 characters"),
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a full URL"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Read and validate environment variables once.
 * Lazy on purpose: importing this module never throws, so `next build` works without secrets.
 * The first call at runtime throws a single readable error listing every problem.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
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
