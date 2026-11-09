/**
 * Which API routes need no session (REQ-NFR-18). Everything else under /api requires one.
 * Pure and import-free, so the Edge middleware and its tests can share it.
 */

/** Exact paths that are open: the health check / keep-alive target. */
const OPEN_PATHS: readonly string[] = ["/api/demo/status"];
/** Prefixes that are open: NextAuth's own endpoints (sign in, session, csrf, ...). */
const OPEN_PREFIXES: readonly string[] = ["/api/auth"];

export function isOpenApiPath(pathname: string): boolean {
  // A single trailing slash is the same route; nothing else is normalised here, because Next has
  // already resolved dot segments and the routes themselves are case-sensitive.
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (OPEN_PATHS.includes(path)) return true;
  return OPEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
