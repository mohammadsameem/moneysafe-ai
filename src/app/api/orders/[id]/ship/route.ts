import { NextResponse } from "next/server";
import { z } from "zod";
import { buildShipDeps } from "@/lib/orders/runtime";
import { CARRIERS, shipOrder } from "@/lib/orders/ship";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** PayPal add-tracking and getOrder (20 s timeout each) plus the database work. No model calls. */
export const maxDuration = 60;

const BodySchema = z
  .object({
    trackingNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, "must be 4-40 letters, digits or dashes"),
    carrier: z.enum(CARRIERS),
  })
  .strict();

/** Mark an order shipped and assemble its evidence (REQ-EV-01). A PayPal tracking failure is a warning, not an error. */
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
  if (!body.success) {
    return NextResponse.json({ error: "invalid_request", issues: body.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }, { status: 400 });
  }

  const result = await shipOrder({ orderId: params.id, sessionId, ...body.data }, buildShipDeps());
  switch (result.kind) {
    case "shipped":
      return NextResponse.json({ status: "shipped", completeness: result.completeness, artefacts: result.artefacts, paypalTracking: result.paypalTracking, warnings: result.warnings });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "shared_example":
      return NextResponse.json({ error: "shared_example", message: "This is a shared example order and cannot be shipped." }, { status: 409 });
    case "not_shippable":
      return NextResponse.json({ error: "not_shippable", message: `Only a paid order can be shipped; this one is ${result.status}.` }, { status: 409 });
  }
}
