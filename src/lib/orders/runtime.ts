/** Binds the order flow to the real database, PayPal client and environment. Used by the route handlers. */
import { getAppBaseUrl } from "@/lib/env";
import { getPayPalClient, isDemoMode } from "@/lib/paypal";
import { createDrizzleOrdersRepo } from "./repo";
import type { OrderDeps } from "./types";

export function buildOrderDeps(): OrderDeps {
  return {
    repo: createDrizzleOrdersRepo(),
    paypal: getPayPalClient(),
    demoMode: isDemoMode(),
    appBaseUrl: getAppBaseUrl(),
    // M1-08 replaces these two with the agent-activity logger. Messages carry no secrets.
    onWarning: (message) => console.warn(`[orders] ${message}`),
    onFallback: ({ reason, message }) => console.warn(`[orders] demo fallback: ${reason}${message ? ` (${message})` : ""}`),
  };
}
