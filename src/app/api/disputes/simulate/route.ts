import { NextResponse } from "next/server";
import { z } from "zod";
import { buildSimulationDeps } from "@/lib/disputes/runtime";
import { simulateDispute } from "@/lib/disputes/simulate";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ orderId: z.string().uuid() }).strict();

/**
 * Demo utility (REQ-DU-02): open a synthetic dispute on a shipped order, for this session only.
 * Idempotent per (session, order): a second call returns 409 with the existing dispute id.
 */
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
  if (!body.success) return NextResponse.json({ error: "invalid_request", message: "orderId must be an order id." }, { status: 400 });

  const result = await simulateDispute({ orderId: body.data.orderId, sessionId }, buildSimulationDeps());
  switch (result.kind) {
    case "created":
      return NextResponse.json({ status: "created", disputeId: result.disputeId });
    case "exists":
      return NextResponse.json(
        { error: "already_exists", disputeId: result.disputeId, message: "You already simulated a dispute on this order." },
        { status: 409 },
      );
    case "order_not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "not_shipped":
      return NextResponse.json({ error: "not_shipped", message: "Only shipped orders can get a simulated dispute." }, { status: 409 });
    case "not_allowed":
      return NextResponse.json({ error: "not_allowed", message: "Simulated disputes are only available for demo orders or in Demo Mode." }, { status: 409 });
  }
}
