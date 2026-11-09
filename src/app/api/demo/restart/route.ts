import { NextResponse } from "next/server";
import { buildRestartDeps } from "@/lib/demo/runtime";
import { restartMyDemo } from "@/lib/demo/reset";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * "Restart my demo" (REQ-DU-03): delete ONLY this session's own orders, disputes, evidence,
 * approvals, executions, outcomes and activity, so Start demo can recreate fresh copies. The seed,
 * other sessions, the shared weights, the proposal, the counter and the insights cache are not
 * touched. Idempotent: restarting twice leaves the same state.
 */
export async function POST(): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await restartMyDemo(sessionId, buildRestartDeps());
  return NextResponse.json({ status: "restarted", scope: "session", deleted: result.deleted });
}
