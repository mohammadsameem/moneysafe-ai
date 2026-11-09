/**
 * NextAuth configuration for the single-merchant demo login (REQ-AUTH-01, REQ-AUTH-02).
 *
 * One public demo account: DEMO_LOGIN_EMAIL plus the DEMO_PASSWORD env var. There is no user
 * table and no real identity provider; this exists so judges can sign in without asking anyone.
 *
 * Each sign-in gets a random session id (`sid`) stored in the signed JWT. It tags the rows a
 * session creates (orders.session_id, ...) and keys the per-session LLM rate limit.
 *
 * The session cookie is SameSite=Lax so it is still sent when PayPal redirects the buyer back to
 * the app after approving a payment (a top-level GET navigation).
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

/** The public demo account's email. Shown on the login page. */
export const DEMO_LOGIN_EMAIL = "demo@moneysafe.ai";
/** The merchant user id recorded on approval records. */
export const MERCHANT_USER_ID = "demo-merchant";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Constant-time string comparison (does not leak how many leading characters matched). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left); // spend similar time, then fail
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface DemoCredentials {
  email?: string;
  password?: string;
}

/** Returns the demo user when the credentials match, otherwise null. Fails closed if no password is set. */
export function authorizeDemo(
  credentials: DemoCredentials | undefined,
  expectedPassword: string | undefined = process.env.DEMO_PASSWORD,
): { id: string; email: string; name: string } | null {
  if (!credentials?.email || !credentials.password || !expectedPassword) return null;
  const emailOk = safeEqual(credentials.email.trim().toLowerCase(), DEMO_LOGIN_EMAIL);
  const passwordOk = safeEqual(credentials.password, expectedPassword);
  return emailOk && passwordOk ? { id: MERCHANT_USER_ID, email: DEMO_LOGIN_EMAIL, name: "Demo merchant" } : null;
}

/** Same rule NextAuth uses itself: secure cookies exactly when the app is served over https. */
const secureCookies = (process.env.NEXTAUTH_URL ?? "").trim().toLowerCase().startsWith("https://");

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Demo login",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      authorize: (credentials) => authorizeDemo(credentials),
    }),
  ],
  cookies: {
    sessionToken: {
      name: secureCookies ? "__Secure-next-auth.session-token" : "next-auth.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: secureCookies },
    },
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) token.sid = randomUUID(); // a fresh session id on every sign-in; kept for the token's life
      return token;
    },
    session({ session, token }) {
      session.sid = typeof token.sid === "string" ? token.sid : undefined;
      return session;
    },
  },
};
