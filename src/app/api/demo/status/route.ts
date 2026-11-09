import { NextResponse } from "next/server";
import { getSql } from "@/db/client";
import { isDemoModeEnabled } from "@/lib/env";

// Never prerender or cache: this must run SELECT 1 on every request (it is the keep-alive target).
export const dynamic = "force-dynamic";

/**
 * Health check, and the target of the keep-alive cron. It deliberately touches the database so the
 * scheduled ping also keeps the Supabase project active (design 11). Exempt from the session check.
 * The response contains no secrets and no error detail.
 */
export async function GET(): Promise<NextResponse> {
  const demoMode = isDemoModeEnabled();
  try {
    await getSql()`SELECT 1`;
    return NextResponse.json({ demoMode, db: "ok" }, { status: 200 });
  } catch {
    return NextResponse.json({ demoMode, db: "error" }, { status: 503 });
  }
}
