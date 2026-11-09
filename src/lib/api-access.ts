/**
 * Which API routes need no session (REQ-NFR-18). Everything else under /api requires one.
 * Pure and import-free, so the Edge middleware and its tests can share it.
 */

/** Exact paths that are open: the health check / keep-alive target. */
const OPEN_PATHS: readonly string[] = ["/api/demo/status"];
/** Prefixes that are open: NextAuth's own endpoints (sign in, session, csrf, ...). */
const OPEN_PREFIXES: readonly string[] = ["/api/auth"];

/** A single trailing slash is the same route; nothing else is normalised here, because Next has
 *  already resolved dot segments and the routes themselves are case-sensitive. */
function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function isOpenApiPath(pathname: string): boolean {
  const path = normalise(pathname);
  if (OPEN_PATHS.includes(path)) return true;
  return OPEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Routes PayPal sends the buyer's BROWSER to. They still need a session, but a person who arrives
 * without one should land on the login page, not on a raw JSON error.
 */
const BROWSER_REDIRECT_PATHS: readonly string[] = ["/api/orders/paypal-return", "/api/orders/paypal-cancel"];

export function isBrowserRedirectPath(pathname: string): boolean {
  return BROWSER_REDIRECT_PATHS.includes(normalise(pathname));
}
