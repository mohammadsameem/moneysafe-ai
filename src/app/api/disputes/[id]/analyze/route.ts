import { NextResponse } from "next/server";
import { analyzeDispute } from "@/lib/disputes/analyze";
import { buildAnalyzeDeps } from "@/lib/disputes/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** Two model calls (analysis, then a draft), each capped at 12 s per provider. */
export const maxDuration = 60;

/**
 * Analyse a dispute (REQ-NFR-14). POST, not GET, because it can call a model and write. Cached:
 * a dispute that already has an analysis, including every seeded one, returns it with no model call.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const outcome = await analyzeDispute(params.id, sessionId, buildAnalyzeDeps());
  switch (outcome.kind) {
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "cached":
      return NextResponse.json({ status: "cached", dispute: outcome.view });
    case "analyzed":
      return NextResponse.json({ status: "analyzed", usedFallback: outcome.usedFallback, dispute: outcome.view });
  }
}
