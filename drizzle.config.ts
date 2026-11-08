import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so load .env.local ourselves (falls back to .env).
config({ path: ".env.local" });
config();

// Migrations need a session-capable connection: use the DIRECT_URL (port 5432).
// The pooled DATABASE_URL (transaction mode, port 6543) is for app runtime only.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

// `generate` only diffs the schema against earlier migrations; it never connects.
const needsConnection = !process.argv.includes("generate");
if (!url && needsConnection) {
  throw new Error("Set DIRECT_URL (preferred) or DATABASE_URL in .env.local before running drizzle-kit.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: url ?? "" },
  strict: true,
  verbose: true,
});
