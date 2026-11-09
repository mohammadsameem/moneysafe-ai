import { getServerSession } from "next-auth";
import { authOptions } from "./auth";

/**
 * The caller's session id (`sid`), or null when not signed in. For route handlers and server
 * components. Rows a session creates are tagged with it; it is never a secret and never a credential.
 */
export async function getSessionId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.sid ?? null;
}
