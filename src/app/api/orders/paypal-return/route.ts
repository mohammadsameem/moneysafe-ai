import { NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/env";
import type { OrderNoticeKey } from "@/lib/orders/notices";
import { buildOrderDeps } from "@/lib/orders/runtime";
import { PayPalTokenSchema } from "@/lib/orders/schemas";
import { handlePayPalReturn } from "@/lib/orders/service";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

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

  const deps = buildOrderDeps();
  const outcome = await handlePayPalReturn(token.data, sessionId, deps);
  switch (outcome.kind) {
    case "ok":
      return redirectTo(`/orders/${outcome.orderId}${outcome.scored ? "" : "?notice=scoring_failed"}`);
    case "cancelled":
      return withNotice("order_cancelled");
    case "capture_failed":
      deps.onWarning?.(`capture failed: ${outcome.message}`);
      return withNotice("capture_failed");
    case "not_found":
      return withNotice("order_not_found");
  }
}
