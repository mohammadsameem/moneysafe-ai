import { NextResponse } from "next/server";
import { ActivityQuerySchema, listActivity } from "@/lib/activity/queries";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The agent activity log, newest first, paginated (REQ-AA-02). Optional ?refOrderId / ?refDisputeId / ?stepType / ?status. */
export async function GET(request: Request): Promise<NextResponse> {
  const sessionId = await getSessionId();
  if (!sessionId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = ActivityQuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }, { status: 400 });
  }
  return NextResponse.json(await listActivity(sessionId, parsed.data), { headers: { "Cache-Control": "no-store" } });
}
