/**
 * Session cookie naming, shared by the NextAuth config (Node) and the middleware (Edge).
 * Kept free of imports so the Edge bundle never pulls in Node-only code.
 *
 * Same rule NextAuth itself uses: secure cookies exactly when the app is served over https.
 */
export function shouldUseSecureCookies(appUrl: string | undefined): boolean {
  return (appUrl ?? "").trim().toLowerCase().startsWith("https://");
}

export function sessionCookieName(appUrl: string | undefined): string {
  return shouldUseSecureCookies(appUrl) ? "__Secure-next-auth.session-token" : "next-auth.session-token";
}
