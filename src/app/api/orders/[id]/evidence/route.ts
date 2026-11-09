import { NextResponse } from "next/server";
import { getOrderEvidence } from "@/lib/orders/evidence-service";
import { buildOrderEvidenceDeps } from "@/lib/orders/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The order's evidence artefacts, completeness score and per-criterion breakdown (REQ-EV-02/04). */
export async function GET(_request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const evidence = await getOrderEvidence(params.id, sessionId, buildOrderEvidenceDeps());
  if (!evidence) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    completeness: evidence.completeness,
    breakdown: evidence.breakdown,
    artefacts: evidence.artefacts.map((a) => ({ id: a.id, type: a.artefactType, source: a.source, isMocked: a.isMocked, createdAt: a.createdAt, payload: a.payload })),
  });
}
