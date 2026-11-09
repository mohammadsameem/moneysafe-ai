import { NextResponse } from "next/server";
import { buildResetDeps } from "@/lib/demo/runtime";
import { resetDemo } from "@/lib/demo/reset";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** One transaction, then (only if the cached summary were stale) one model call. */
export const maxDuration = 60;

/**
 * Reset demo for ALL sessions (REQ-DU-01): delete every visitor's data and restore the seed, atomically.
 * Needs a session. A second reset within 10 s gets 429 with Retry-After. The global LLM daily usage
 * and the per-session rate-limit rows are never touched.
 */
export async function POST(): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await resetDemo(sessionId, buildResetDeps());
  if (result.kind === "cooldown") {
    return NextResponse.json(
      { error: "cooldown", retryAfterSeconds: result.retryAfterSeconds, message: `The demo was reset a moment ago. Try again in ${result.retryAfterSeconds} s.` },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
    );
  }
  return NextResponse.json({ status: "reset", scope: "all", deleted: result.deleted });
}
