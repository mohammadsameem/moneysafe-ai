import { NextResponse } from "next/server";
import { CommunicationRequestSchema, appendCommunication } from "@/lib/orders/evidence-service";
import { buildOrderEvidenceDeps } from "@/lib/orders/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Append one buyer communication to the order's evidence (append-only, REQ-EV-03). */
export async function POST(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = CommunicationRequestSchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json({ error: "invalid_request", issues: body.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }, { status: 400 });
  }

  const result = await appendCommunication(params.id, sessionId, body.data, buildOrderEvidenceDeps());
  switch (result.kind) {
    case "appended":
      return NextResponse.json({ status: "appended", completeness: result.completeness }, { status: 201 });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "shared_example":
      return NextResponse.json({ error: "shared_example", message: "This is a shared example order; its evidence cannot be changed." }, { status: 409 });
    case "not_shipped":
      return NextResponse.json({ error: "not_shipped", message: "Messages can be logged once the order has shipped." }, { status: 409 });
    case "invalid":
      return NextResponse.json({ error: "invalid", message: result.message }, { status: 400 });
  }
}
