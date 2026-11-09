/** Binds the order flow to the real database, PayPal client and environment. Used by the route handlers. */
import { getAppBaseUrl } from "@/lib/env";
import { logActivity } from "@/lib/activity/logger";
import { getPayPalClient, isDemoMode } from "@/lib/paypal";
import { createDrizzleOrdersRepo } from "./repo";
import type { OrderDeps } from "./types";

export function buildOrderDeps(): OrderDeps {
  return {
    repo: createDrizzleOrdersRepo(),
    paypal: getPayPalClient(),
    demoMode: isDemoMode(),
    appBaseUrl: getAppBaseUrl(),
    log: logActivity,
  };
}
