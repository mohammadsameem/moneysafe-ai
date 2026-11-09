import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_LOGIN_EMAIL, MERCHANT_USER_ID, authOptions, authorizeDemo, safeEqual } from "../auth";

const PASSWORD = "correct horse battery";

describe("safeEqual", () => {
  it("is true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
  });
});

describe("authorizeDemo", () => {
  it("accepts the demo email and password and returns the merchant user", () => {
    expect(authorizeDemo({ email: DEMO_LOGIN_EMAIL, password: PASSWORD }, PASSWORD)).toEqual({
      id: MERCHANT_USER_ID,
      email: DEMO_LOGIN_EMAIL,
      name: "Demo merchant",
    });
  });

  it("ignores case and surrounding spaces in the email", () => {
    expect(authorizeDemo({ email: `  ${DEMO_LOGIN_EMAIL.toUpperCase()} `, password: PASSWORD }, PASSWORD)).not.toBeNull();
  });

  it("is case-sensitive for the password", () => {
    expect(authorizeDemo({ email: DEMO_LOGIN_EMAIL, password: PASSWORD.toUpperCase() }, PASSWORD)).toBeNull();
  });

  it.each([
    ["a wrong password", { email: DEMO_LOGIN_EMAIL, password: "nope" }],
    ["a wrong email", { email: "someone@else.com", password: PASSWORD }],
    ["a missing password", { email: DEMO_LOGIN_EMAIL }],
    ["an empty password", { email: DEMO_LOGIN_EMAIL, password: "" }],
    ["a missing email", { password: PASSWORD }],
    ["no credentials", undefined],
  ])("rejects %s", (_name, credentials) => {
    expect(authorizeDemo(credentials, PASSWORD)).toBeNull();
  });

  it("fails closed when DEMO_PASSWORD is not configured, even for an empty password", () => {
    expect(authorizeDemo({ email: DEMO_LOGIN_EMAIL, password: "" }, undefined)).toBeNull();
    expect(authorizeDemo({ email: DEMO_LOGIN_EMAIL, password: "anything" }, undefined)).toBeNull();
    expect(authorizeDemo({ email: DEMO_LOGIN_EMAIL, password: "anything" }, "")).toBeNull();
  });
});

describe("session callbacks", () => {
  const jwt = authOptions.callbacks!.jwt!;
  const session = authOptions.callbacks!.session!;
  const signIn = (token: object) => ({ token, user: { id: MERCHANT_USER_ID }, account: null }) as unknown as Parameters<typeof jwt>[0];
  const refresh = (token: object) => ({ token }) as unknown as Parameters<typeof jwt>[0];

  it("gives every sign-in its own random session id", async () => {
    const first = await jwt(signIn({}));
    const second = await jwt(signIn({}));
    expect(first.sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.sid).not.toBe(second.sid);
  });

  it("keeps the session id on later requests", async () => {
    const { sid } = await jwt(signIn({}));
    expect((await jwt(refresh({ sid }))).sid).toBe(sid);
  });

  it("exposes the session id on the session object", async () => {
    const result = await session({ session: { user: {}, expires: "" }, token: { sid: "abc" } } as unknown as Parameters<typeof session>[0]);
    expect((result as { sid?: string }).sid).toBe("abc");
  });

  it("exposes no session id when the token has none", async () => {
    const result = await session({ session: { user: {}, expires: "" }, token: {} } as unknown as Parameters<typeof session>[0]);
    expect((result as { sid?: string }).sid).toBeUndefined();
  });
});

describe("session cookie (survives the PayPal redirect)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const loadWithUrl = async (url: string) => {
    vi.resetModules();
    vi.stubEnv("NEXTAUTH_URL", url);
    return (await import("../auth")).authOptions.cookies?.sessionToken;
  };

  it("is SameSite=Lax and HttpOnly, so a top-level GET back from PayPal carries it", async () => {
    const cookie = await loadWithUrl("http://localhost:3000");
    expect(cookie?.options).toMatchObject({ sameSite: "lax", httpOnly: true, path: "/", secure: false });
    expect(cookie?.name).toBe("next-auth.session-token");
  });

  it("is Secure with the __Secure- prefix when the app is served over https", async () => {
    const cookie = await loadWithUrl("https://moneysafe.example");
    expect(cookie?.options).toMatchObject({ sameSite: "lax", httpOnly: true, secure: true });
    expect(cookie?.name).toBe("__Secure-next-auth.session-token");
  });
});

describe("authOptions", () => {
  it("uses signed JWT sessions with a bounded lifetime and the /login page", () => {
    expect(authOptions.session).toMatchObject({ strategy: "jwt", maxAge: 8 * 60 * 60 });
    expect(authOptions.pages?.signIn).toBe("/login");
  });
});
