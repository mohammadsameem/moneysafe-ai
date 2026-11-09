import { NextResponse } from "next/server";
import { z } from "zod";
import { buildSimulationDeps } from "@/lib/disputes/runtime";
import { simulateOutcome } from "@/lib/disputes/simulate";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** The outcome is recorded, then the learning loop may ask a model (a proposal, a refreshed summary). */
export const maxDuration = 60;

const BodySchema = z.object({ outcome: z.enum(["won", "lost"]) }).strict();

/**
 * Demo utility (REQ-DIS-11): record a simulated Won / Lost outcome on this session's demo dispute,
 * after its evidence was submitted. Not available on the refund path.
 */
export async function POST(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = BodySchema.safeParse(json);
  if (!body.success) return NextResponse.json({ error: "invalid_request", message: "outcome must be won or lost." }, { status: 400 });

  const result = await simulateOutcome({ disputeId: params.id, sessionId, outcome: body.data.outcome }, buildSimulationDeps());
  switch (result.kind) {
    case "recorded":
      return NextResponse.json({ status: "recorded", outcome: result.outcome, simulated: true, dispute: result.view });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "not_demo":
      return NextResponse.json({ error: "not_demo", message: "Outcomes can only be simulated on your own demo disputes." }, { status: 409 });
    case "refund_path":
      return NextResponse.json({ error: "refund_path", message: "This dispute was refunded; its outcome was recorded automatically." }, { status: 409 });
    case "not_contested":
      return NextResponse.json({ error: "not_contested", message: "Approve and submit the evidence first." }, { status: 409 });
    case "already_resolved":
      return NextResponse.json({ error: "already_resolved", message: "This dispute is already resolved.", dispute: result.view }, { status: 409 });
  }
}
