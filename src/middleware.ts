/**
 * API session protection (REQ-NFR-18): every /api route needs a valid NextAuth session except the
 * health check and NextAuth's own endpoints. An unauthenticated call gets 401 JSON.
 *
 * This is the first gate. Route handlers still check the session themselves (defence in depth),
 * because they need the session id anyway.
 */
import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { isBrowserRedirectPath, isOpenApiPath } from "@/lib/api-access";
import { sessionCookieName } from "@/lib/session-cookie";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (isOpenApiPath(request.nextUrl.pathname)) return NextResponse.next();

  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName: sessionCookieName(process.env.NEXTAUTH_URL),
  });
  // A real sign-in always stamps a session id; a token without one is not one of ours.
  if (!token || typeof token.sid !== "string" || token.sid === "") {
    // PayPal's return/cancel redirects are browser navigations: send the person to the login page.
    if (isBrowserRedirectPath(request.nextUrl.pathname)) {
      return NextResponse.redirect(new URL("/login", request.url), 302);
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
