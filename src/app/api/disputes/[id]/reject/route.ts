import { NextResponse } from "next/server";
import { z } from "zod";
import { MERCHANT_USER_ID } from "@/lib/auth";
import { rejectDispute } from "@/lib/disputes/approve";
import { buildApproveDeps } from "@/lib/disputes/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ action: z.enum(["submit_evidence", "accept_claim"]) }).strict();

/** Record that the merchant rejected the recommended action (REQ-DIS-05). Nothing is sent to PayPal. */
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
  if (!body.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const { repo, log } = buildApproveDeps();
  const result = await rejectDispute({ disputeId: params.id, sessionId, merchantUserId: MERCHANT_USER_ID, action: body.data.action }, { repo, log });

  switch (result.kind) {
    case "rejected":
      return NextResponse.json({ status: "rejected", dispute: result.view });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "not_analyzed":
      return NextResponse.json({ error: "not_analyzed", message: "This dispute has not been analysed yet." }, { status: 409 });
    case "wrong_action":
      return NextResponse.json({ error: "wrong_action", expected: result.expected }, { status: 409 });
    case "not_open":
      return NextResponse.json({ error: "not_open", message: "This dispute is no longer open." }, { status: 409 });
    case "already_approved":
      return NextResponse.json({ error: "already_approved", message: "This action was already approved, so it cannot be rejected." }, { status: 409 });
  }
}
