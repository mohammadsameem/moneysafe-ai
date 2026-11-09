import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeOrder } from "@/lib/orders/__tests__/fakes";

const getSessionId = vi.fn();
const listVisible = vi.fn();
const findVisible = vi.fn();

vi.mock("@/lib/session", () => ({ getSessionId: () => getSessionId() }));
vi.mock("@/lib/orders/runtime", () => ({ buildOrderDeps: () => ({}) }));
vi.mock("@/lib/orders/service", () => ({ createSandboxOrder: vi.fn() }));
vi.mock("@/lib/orders/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orders/queries")>()),
  createDrizzleReadRepo: () => ({ listVisible, findVisible }),
}));

import { GET as getOne } from "../[id]/route";
import { GET as getList } from "../route";

beforeEach(() => {
  getSessionId.mockReset().mockResolvedValue("sid-1");
  listVisible.mockReset();
  findVisible.mockReset();
});

describe("GET /api/orders", () => {
  it("401 without a session, and reads nothing", async () => {
    getSessionId.mockResolvedValue(null);
    expect((await getList()).status).toBe(401);
    expect(listVisible).not.toHaveBeenCalled();
  });

  it("lists orders as summaries with riskScore, verdict and isDemo, scoped to the session", async () => {
    listVisible.mockResolvedValue([
      makeOrder({ id: "a", riskScore: 55, verdict: "verify", isSeed: true, sessionId: null }),
      makeOrder({ id: "b", riskScore: null, verdict: null, isDemo: false }),
    ]);

    const res = await getList();
    const body = (await res.json()) as { orders: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(listVisible).toHaveBeenCalledWith("sid-1");
    expect(body.orders.map((o) => [o.id, o.riskScore, o.verdict, o.isDemo])).toEqual([
      ["a", 55, "verify", true],
      ["b", null, null, false],
    ]);
    expect(body.orders[0]).not.toHaveProperty("signalBreakdown"); // detail only
    expect(JSON.stringify(body)).not.toContain("sessionId");
  });

  it("returns an empty list, not an error, when there are no orders", async () => {
    listVisible.mockResolvedValue([]);
    const res = await getList();
    expect(await res.json()).toEqual({ orders: [] });
  });
});

describe("GET /api/orders/[id]", () => {
  const call = (id: string) => getOne(new Request(`http://localhost/api/orders/${id}`), { params: { id } });

  it("401 without a session", async () => {
    getSessionId.mockResolvedValue(null);
    expect((await call("x")).status).toBe(401);
    expect(findVisible).not.toHaveBeenCalled();
  });

  it("404 when the order is not visible to the caller, with no hint why", async () => {
    findVisible.mockResolvedValue(null);
    const res = await call("22222222-2222-4222-8222-222222222222");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(findVisible).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "sid-1");
  });

  it("returns the detail with signal breakdown, AI explanation and usedFallback", async () => {
    findVisible.mockResolvedValue(
      makeOrder({
        id: "o-1",
        riskScore: 40,
        verdict: "verify",
        aiExplanation: "Two signals fired.",
        usedFallback: true,
        signalBreakdown: [{ signal: "country_mismatch", active: true, weight: 20 }],
      }),
    );
    const res = await call("o-1");
    const { order } = (await res.json()) as { order: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(order).toMatchObject({
      id: "o-1",
      riskScore: 40,
      aiExplanation: "Two signals fired.",
      usedFallback: true,
      signalBreakdown: [{ signal: "country_mismatch", active: true, weight: 20 }],
    });
  });
});
