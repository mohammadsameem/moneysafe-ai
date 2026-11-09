import { beforeEach, describe, expect, it, vi } from "vitest";

const getServerSession = vi.fn();
vi.mock("next-auth", () => ({ getServerSession: (...args: unknown[]) => getServerSession(...args) }));

import { authOptions } from "../auth";
import { getSessionId } from "../session";

describe("getSessionId", () => {
  beforeEach(() => getServerSession.mockReset());

  it("returns the session id of a signed-in caller", async () => {
    getServerSession.mockResolvedValueOnce({ user: {}, expires: "", sid: "sid-1" });
    expect(await getSessionId()).toBe("sid-1");
    expect(getServerSession).toHaveBeenCalledWith(authOptions);
  });

  it("returns null when nobody is signed in", async () => {
    getServerSession.mockResolvedValueOnce(null);
    expect(await getSessionId()).toBeNull();
  });

  it("returns null for a session that carries no session id", async () => {
    getServerSession.mockResolvedValueOnce({ user: {}, expires: "" });
    expect(await getSessionId()).toBeNull();
  });
});
