import { NextResponse } from "next/server";
import { buildOrderDeps } from "@/lib/orders/runtime";
import { CreateOrderRequestSchema } from "@/lib/orders/schemas";
import { createSandboxOrder } from "@/lib/orders/service";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** A demo order is scored, and AI-enriched, in this request; allow time for a slow model. */
export const maxDuration = 60;

/**
 * Create a PayPal sandbox order. Returns the URL to send the buyer to for approval. When PayPal
 * is not used (Demo Mode, no credentials, or the sandbox is down) it creates a scored demo order
 * instead and returns `approvalUrl: null` with `isDemo: true`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = CreateOrderRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
    return NextResponse.json({ error: "invalid_request", issues }, { status: 400 });
  }

  const outcome = await createSandboxOrder(parsed.data, sessionId, buildOrderDeps());
  if (outcome.kind === "paypal") {
    return NextResponse.json({ orderId: outcome.orderId, approvalUrl: outcome.approvalUrl, isDemo: false }, { status: 201 });
  }
  return NextResponse.json(
    { orderId: outcome.orderId, approvalUrl: null, isDemo: true, reason: outcome.reason },
    { status: 201 },
  );
}
