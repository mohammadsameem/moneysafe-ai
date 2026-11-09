import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** Random id for this sign-in; tags rows created in the session. */
    sid?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sid?: string;
  }
}
