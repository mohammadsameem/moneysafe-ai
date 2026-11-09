import { NextResponse } from "next/server";
import { createDrizzleReadRepo, toOrderDetail } from "@/lib/orders/queries";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** One order with its signal breakdown, AI explanation and `usedFallback`. 404 if it is not yours. */
export async function GET(_request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const order = await createDrizzleReadRepo().findVisible(params.id, sessionId);
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ order: toOrderDetail(order) });
}
