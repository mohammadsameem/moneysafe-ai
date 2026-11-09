import { NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/env";
import type { OrderNoticeKey } from "@/lib/orders/notices";
import { buildOrderDeps } from "@/lib/orders/runtime";
import { PayPalTokenSchema } from "@/lib/orders/schemas";
import { handlePayPalReturn } from "@/lib/orders/service";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
/** Capture, scoring and the AI steps run in this request. The two AI calls run in parallel: worst case 2 providers x 8 s = 16 s. */
export const maxDuration = 60;

/**
 * PayPal sends the buyer here (a top-level GET navigation, so the SameSite=Lax session cookie is
 * present) after they approve the payment. Captures the order, scores it and redirects to it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const base = getAppBaseUrl();
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, base), 303);
  const withNotice = (notice: OrderNoticeKey) => redirectTo(`/orders?notice=${notice}`);

  const sessionId = await getSessionId();
  if (!sessionId) return redirectTo("/login");

  const token = PayPalTokenSchema.safeParse(new URL(request.url).searchParams.get("token"));
  if (!token.success) return withNotice("order_not_found");

  // The service logs each step (including a failed capture) to the agent-activity log.
  const outcome = await handlePayPalReturn(token.data, sessionId, buildOrderDeps());
  switch (outcome.kind) {
    case "ok":
      return redirectTo(`/orders/${outcome.orderId}${outcome.scored ? "" : "?notice=scoring_failed"}`);
    case "cancelled":
      return withNotice("order_cancelled");
    case "capture_failed":
      return withNotice("capture_failed");
    case "not_found":
      return withNotice("order_not_found");
  }
}
