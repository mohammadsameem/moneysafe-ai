import { NextResponse } from "next/server";
import { loadDashboard } from "@/lib/dashboard/load";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Dashboard metrics (REQ-DASH-01/02/03) for this session's data plus the shared demo history.
 * Read-only; it never calls a model.
 */
export async function GET(): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await loadDashboard(sessionId));
}
