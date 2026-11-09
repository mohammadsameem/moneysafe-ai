import { NextResponse } from "next/server";
import { z } from "zod";
import { MERCHANT_USER_ID } from "@/lib/auth";
import { approveDispute } from "@/lib/disputes/approve";
import { buildApproveDeps } from "@/lib/disputes/runtime";
import { SHARED_EXAMPLE_MESSAGE } from "@/lib/demo/copies";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** A live PayPal call (20 s timeout) plus the database work. */
export const maxDuration = 60;

const BodySchema = z
  .object({
    action: z.enum(["submit_evidence", "accept_claim"]),
    /** The merchant's edited draft. PayPal accepts up to 2000 characters. */
    editedDraft: z.string().max(2000, "must be at most 2000 characters").nullish(),
  })
  .strict();

/**
 * Approve the recommended action (REQ-DIS-05..09). Idempotent: approving again after success says
 * "already executed"; approving again after a failed live call retries with the same request id.
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
  if (!body.success) {
    const issues = body.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
    return NextResponse.json({ error: "invalid_request", issues }, { status: 400 });
  }

  const result = await approveDispute(
    { disputeId: params.id, sessionId, merchantUserId: MERCHANT_USER_ID, action: body.data.action, editedDraft: body.data.editedDraft },
    buildApproveDeps(),
  );

  switch (result.kind) {
    case "executed":
      return NextResponse.json({ status: "executed", simulated: result.simulated, retried: result.retried, execution: result.execution, dispute: result.view });
    case "already_executed":
      return NextResponse.json({ status: "already_executed", message: "Action already executed", execution: result.execution, dispute: result.view });
    case "execution_failed":
      // 502: the dispute service is fine; PayPal was not. The merchant can press Approve again to retry.
      return NextResponse.json(
        { status: "execution_failed", retryable: true, message: result.message, execution: result.execution, dispute: result.view },
        { status: 502 },
      );
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "shared_example":
      return NextResponse.json({ error: "shared_example", message: SHARED_EXAMPLE_MESSAGE }, { status: 409 });
    case "not_analyzed":
      return NextResponse.json({ error: "not_analyzed", message: "This dispute has not been analysed yet." }, { status: 409 });
    case "wrong_action":
      return NextResponse.json({ error: "wrong_action", expected: result.expected, message: `The recommended action for this dispute is ${result.expected}.` }, { status: 409 });
    case "not_open":
      return NextResponse.json({ error: "not_open", message: "This dispute is no longer open." }, { status: 409 });
    case "invalid":
      return NextResponse.json({ error: "invalid", message: result.message }, { status: 400 });
  }
}
