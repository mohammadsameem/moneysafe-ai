import { NextResponse } from "next/server";
import { startDemo } from "@/lib/demo/copies";
import { buildStartDemoDeps } from "@/lib/demo/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * "Start demo" (M3-08): create this session's own copies of SEED-C, SEED-D and SEED-E, with their
 * stored analysis (no model call). Idempotent: a second call creates nothing and returns the same copies.
 */
export async function POST(): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await startDemo(sessionId, buildStartDemoDeps());
  if (result.kind === "seed_missing") {
    return NextResponse.json({ error: "seed_missing", message: `The demo data is incomplete (${result.key} is missing). Run the seed, then try again.` }, { status: 409 });
  }
  return NextResponse.json({
    status: result.created > 0 ? "created" : "existing",
    created: result.created,
    copies: result.copies.map((c) => ({ key: c.key, seedDisputeId: c.seedDisputeId, disputeId: c.disputeId, created: c.created })),
  });
}
