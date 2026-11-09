import { NextResponse } from "next/server";
import { z } from "zod";
import { rejectWeights } from "@/lib/insights/decide";
import { decisionRefusal } from "@/lib/insights/http";
import { buildDecideDeps, refreshInsightsSummary } from "@/lib/insights/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** The decision is stored first; then the cached summary may be refreshed (one model call). */
export const maxDuration = 60;

const BodySchema = z.object({ proposalCreatedAt: z.string().min(1).max(64) }).strict();

/** Discard the pending weight proposal (REQ-LL-02). The weights and the counter are left as they were. */
export async function POST(request: Request): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = BodySchema.safeParse(json);
  if (!body.success) return NextResponse.json({ error: "invalid_request", message: "proposalCreatedAt is required." }, { status: 400 });

  const result = await rejectWeights({ sessionId, proposalCreatedAt: body.data.proposalCreatedAt }, buildDecideDeps());
  const refusal = decisionRefusal(result);
  if (refusal) return refusal;

  await refreshInsightsSummary(sessionId); // the proposal is gone: refresh the cached summary (write path)
  return NextResponse.json({ status: "rejected" });
}
