import { NextResponse } from "next/server";
import { ingestPayPalDisputes } from "@/lib/disputes/ingest";
import { buildIngestDeps } from "@/lib/disputes/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** One PayPal list call plus up to 20 single reads (each has a 20 s timeout, but they normally take under a second). */
export const maxDuration = 60;

/**
 * Link the caller's REAL PayPal disputes (REQ-DIS-01). Reads PayPal and creates a local dispute only for a dispute whose
 * transaction is the capture of a real order that belongs to THIS session; it never sends anything to PayPal.
 */
export async function POST(): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await ingestPayPalDisputes(sessionId, buildIngestDeps());
  if (result.kind === "unavailable") return NextResponse.json({ error: "unavailable", message: result.message }, { status: 409 });
  return NextResponse.json({
    status: "ok",
    checked: result.checked,
    linked: result.linked.map((l) => ({ disputeId: l.disputeId, created: l.created })),
    skipped: result.skipped,
  });
}
