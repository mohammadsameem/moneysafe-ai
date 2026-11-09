import { NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/env";
import { buildOrderDeps } from "@/lib/orders/runtime";
import { PayPalTokenSchema } from "@/lib/orders/schemas";
import { handlePayPalCancel } from "@/lib/orders/service";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** PayPal sends the buyer here if they back out of the approval page. Marks the order cancelled. */
export async function GET(request: Request): Promise<NextResponse> {
  const base = getAppBaseUrl();
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, base), 303);

  const sessionId = await getSessionId();
  if (!sessionId) return redirectTo("/login");

  const token = PayPalTokenSchema.safeParse(new URL(request.url).searchParams.get("token"));
  if (!token.success) return redirectTo("/orders?notice=order_not_found");

  const outcome = await handlePayPalCancel(token.data, sessionId, buildOrderDeps());
  switch (outcome.kind) {
    case "cancelled":
      return redirectTo("/orders?notice=order_cancelled");
    case "not_found":
      return redirectTo("/orders?notice=order_not_found");
    case "not_cancellable": // already paid: leave it alone
      return redirectTo("/orders");
  }
}
