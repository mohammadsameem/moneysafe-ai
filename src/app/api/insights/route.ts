import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { loadInsights } from "@/lib/insights/read";
import { createDrizzleInsightsRepo } from "@/lib/insights/repo";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Weights, deltas, the pending proposal, the outcome breakdown and the CACHED summary (REQ-LL-03).
 * This route never calls a model: it imports only the read model and the repository. The summary
 * is refreshed by write paths (an outcome, a proposal, approve / reject, reset), never here.
 */
export async function GET(): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const view = await loadInsights(createDrizzleInsightsRepo(getDb()));
  if (!view) return NextResponse.json({ error: "not_seeded", message: "The demo data has not been loaded. Run the seed." }, { status: 503 });
  return NextResponse.json(view);
}
