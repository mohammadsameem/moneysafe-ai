import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ActivityMeta } from "@/lib/activity/logger";
import { PayPalError } from "@/lib/paypal";
import { createFakePayPal } from "@/lib/orders/__tests__/fakes";
import { URGENT_BELOW_HOURS, computeDeadline, formatCountdown } from "../deadline";
import { getDisputeView, isResolvedStatus, listDisputeViews, toDisputeView } from "../read";
import { NOW, OTHER_SESSION, SESSION, analysed, createFakeReadRepo, makeDispute, makeRecord } from "./fakes";

config({ path: ".env.local", quiet: true });

const HOUR = 3_600_000;
const deps = (records: ReturnType<typeof makeRecord>[], extra: Partial<Parameters<typeof listDisputeViews>[2]> = {}) => ({
  repo: createFakeReadRepo(records),
  paypal: null,
  demoMode: false,
  now: () => NOW,
  ...extra,
});

describe("computeDeadline (offsets are applied at read time)", () => {
  it("seed disputes: now + stored offset, whatever placeholder is stored", () => {
    const row = { isSeed: true, deadlineOffsetHours: 72, deadlineAt: "2099-01-01T00:00:00Z" };
    expect(computeDeadline(row, NOW)).toBe(new Date(NOW.getTime() + 72 * HOUR).toISOString());
    expect(computeDeadline(row, new Date(NOW.getTime() + 10 * HOUR))).toBe(new Date(NOW.getTime() + 82 * HOUR).toISOString());
  });

  it("an offset of 0 means 'now', not 'use the stored value'", () => {
    expect(computeDeadline({ isSeed: true, deadlineOffsetHours: 0, deadlineAt: "2099-01-01T00:00:00Z" }, NOW)).toBe(NOW.toISOString());
  });

  it("non-seed disputes keep their stored deadline, even if an offset is present", () => {
    expect(computeDeadline({ isSeed: false, deadlineOffsetHours: 72, deadlineAt: "2026-12-01T00:00:00.000Z" }, NOW)).toBe("2026-12-01T00:00:00.000Z");
    expect(computeDeadline({ isSeed: true, deadlineOffsetHours: null, deadlineAt: "2026-03-01T00:00:00.000Z" }, NOW)).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("formatCountdown", () => {
  const at = (hours: number, extraMinutes = 0) => new Date(NOW.getTime() + hours * HOUR + extraMinutes * 60_000).toISOString();

  it("formats days+hours, hours+minutes and minutes", () => {
    expect(formatCountdown(at(72), NOW).text).toBe("3d 0h");
    expect(formatCountdown(at(47, 59), NOW).text).toBe("1d 23h");
    expect(formatCountdown(at(5, 12), NOW).text).toBe("5h 12m");
    expect(formatCountdown(at(0, 42), NOW).text).toBe("42m");
    expect(formatCountdown(new Date(NOW.getTime() + 20_000).toISOString(), NOW).text).toBe("1m");
  });

  it("is urgent (red) below 48 hours, and not at exactly 48 hours or more", () => {
    expect(URGENT_BELOW_HOURS).toBe(48);
    expect(formatCountdown(at(47, 59), NOW).urgent).toBe(true);
    expect(formatCountdown(at(48), NOW).urgent).toBe(false);
    expect(formatCountdown(at(72), NOW).urgent).toBe(false);
    expect(formatCountdown(at(40), NOW).urgent).toBe(true); // SEED-E
  });

  it("an expired or invalid deadline is shown as overdue / unknown and urgent", () => {
    expect(formatCountdown(at(0), NOW)).toMatchObject({ text: "Overdue", urgent: true, overdue: true });
    expect(formatCountdown(at(-5), NOW)).toMatchObject({ text: "Overdue", overdue: true });
    expect(formatCountdown("not a date", NOW)).toMatchObject({ text: "Unknown", urgent: true });
  });
});

describe("toDisputeView", () => {
  it("maps a stored analysis, and flags a stored analysis with no win probability as AI-unavailable", () => {
    const ai = toDisputeView(makeRecord(analysed()), NOW).analysis;
    expect(ai).toMatchObject({ winProbability: 0.95, winLikelihoodLabel: "Strong", finalRecommendation: "contest", aiUnavailable: false });

    const noAi = toDisputeView(makeRecord(analysed({ winProbability: null, winLikelihoodLabel: null, llmAdjustment: null })), NOW).analysis;
    expect(noAi).toMatchObject({ winProbability: null, winLikelihoodLabel: null, aiUnavailable: true });
  });

  it("has no analysis until one is computed", () => {
    expect(toDisputeView(makeRecord(makeDispute()), NOW).analysis).toBeNull();
  });

  it("flags seeded and demo disputes, and never exposes the session id or PayPal ids", () => {
    expect(toDisputeView(makeRecord(makeDispute({ isSeed: true, isDemo: false })), NOW).isDemo).toBe(true);
    expect(toDisputeView(makeRecord(makeDispute({ isSeed: false, isDemo: false, paypalDisputeId: "PP-SECRET" })), NOW).isDemo).toBe(false);
    const text = JSON.stringify(toDisputeView(makeRecord(makeDispute({ sessionId: "sid-private", paypalDisputeId: "PP-SECRET" })), NOW));
    expect(text).not.toContain("sid-private");
    expect(text).not.toContain("PP-SECRET");
  });

  it("resolved status helper", () => {
    for (const s of ["resolved_won", "resolved_lost", "resolved_refunded"] as const) expect(isResolvedStatus(s)).toBe(true);
    for (const s of ["open", "action_taken"] as const) expect(isResolvedStatus(s)).toBe(false);
  });
});

describe("listDisputeViews", () => {
  const open = (id: string, hours: number | null, over = {}) =>
    makeRecord(
      analysed({ id, orderId: `${id}-order`, isSeed: true, isDemo: false, sessionId: null, deadlineOffsetHours: hours, deadlineAt: "2099-01-01T00:00:00Z", ...over }),
    );
  const resolved = (id: string, resolvedAt: string, status: "resolved_won" | "resolved_lost" | "resolved_refunded") =>
    makeRecord(analysed({ id, orderId: `${id}-order`, isSeed: true, isDemo: false, sessionId: null, status, outcome: "won", updatedAt: resolvedAt }));

  it("Open tab: only unresolved disputes, soonest deadline first, offsets applied", async () => {
    const records = [
      open("c-72", 72),
      open("d-48", 48),
      open("e-40", 40),
      resolved("h1", "2026-10-01T00:00:00.000Z", "resolved_won"),
      makeRecord(analysed({ id: "acted", orderId: "acted-order", status: "action_taken" })), // awaiting PayPal: not resolved
    ];
    const views = await listDisputeViews(SESSION, "open", deps(records));

    // 40 h, 48 h, 72 h from the offsets; "acted" keeps its stored deadline (NOW + 96 h).
    expect(views.map((v) => v.id)).toEqual(["e-40", "d-48", "c-72", "acted"]);
    expect(views.find((v) => v.id === "e-40")?.deadlineAt).toBe(new Date(NOW.getTime() + 40 * HOUR).toISOString());
    expect(views.find((v) => v.id === "c-72")?.deadlineAt).toBe(new Date(NOW.getTime() + 72 * HOUR).toISOString());
    expect(views.map((v) => v.id)).not.toContain("h1"); // resolved disputes never appear in the open inbox
  });

  it("Resolved tab: only resolved disputes, most recently resolved first", async () => {
    const records = [
      resolved("old", "2026-09-01T00:00:00.000Z", "resolved_lost"),
      resolved("new", "2026-10-20T00:00:00.000Z", "resolved_refunded"),
      resolved("mid", "2026-10-01T00:00:00.000Z", "resolved_won"),
      open("c-72", 72),
    ];
    const views = await listDisputeViews(SESSION, "resolved", deps(records));
    expect(views.map((v) => v.id)).toEqual(["new", "mid", "old"]);
    expect(views.every((v) => v.resolvedAt !== null)).toBe(true);
  });

  it("a dispute is never on both tabs", async () => {
    const records = [open("a", 10), resolved("b", "2026-10-01T00:00:00.000Z", "resolved_won")];
    const openIds = (await listDisputeViews(SESSION, "open", deps(records))).map((v) => v.id);
    const resolvedIds = (await listDisputeViews(SESSION, "resolved", deps(records))).map((v) => v.id);
    expect(openIds.filter((id) => resolvedIds.includes(id))).toEqual([]);
    expect([...openIds, ...resolvedIds].sort()).toEqual(["a", "b"]);
  });

  it("shows seeded disputes plus this session's own, never another session's", async () => {
    const records = [open("seed", 10), makeRecord(analysed({ id: "mine", orderId: "m-o", sessionId: SESSION })), makeRecord(analysed({ id: "theirs", orderId: "t-o", sessionId: OTHER_SESSION }))];
    const ids = (await listDisputeViews(SESSION, "open", deps(records))).map((v) => v.id);
    expect(ids).toContain("seed");
    expect(ids).toContain("mine");
    expect(ids).not.toContain("theirs");
  });

  it("makes no PayPal call and logs nothing for seeded and demo disputes", async () => {
    const paypal = createFakePayPal({});
    const log = vi.fn(async () => undefined);
    await listDisputeViews(SESSION, "open", deps([open("seed", 10), makeRecord(analysed({ id: "demo", orderId: "d-o" }))], { paypal, log }));
    expect(paypal.request).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("live-linked disputes (REQ-DEMO-01 fallback)", () => {
  const live = () => makeRecord(analysed({ id: "live", orderId: "live-o", isSeed: false, isDemo: false, paypalDisputeId: "PP-D-1", deadlineAt: "2026-11-20T00:00:00.000Z" }));
  const getKey = "GET /v1/customer/disputes/PP-D-1";

  it("uses PayPal's seller_response_due_date when PayPal answers", async () => {
    const paypal = createFakePayPal({ [getKey]: { dispute_id: "PP-D-1", status: "WAITING_FOR_SELLER_RESPONSE", seller_response_due_date: "2026-11-11T09:30:00Z" } });
    const [view] = await listDisputeViews(SESSION, "open", deps([live()], { paypal }));
    expect(view?.deadlineAt).toBe("2026-11-11T09:30:00.000Z");
    expect(paypal.request).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stored record, and logs a Demo Mode event, when PayPal fails", async () => {
    const paypal = createFakePayPal({ [getKey]: new PayPalError("PayPal could not be reached") });
    const log = vi.fn<(meta: ActivityMeta) => Promise<void>>(async () => undefined);
    const [view] = await listDisputeViews(SESSION, "open", deps([live()], { paypal, log }));
    expect(view?.deadlineAt).toBe("2026-11-20T00:00:00.000Z");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ stepType: "paypal_api", toolName: "get_dispute", status: "simulated", refDisputeId: "live" });
  });

  it("uses the stored record, with a logged Demo Mode event, with no credentials or in DEMO_MODE, without calling PayPal", async () => {
    const log = vi.fn(async () => undefined);
    await listDisputeViews(SESSION, "open", deps([live()], { paypal: null, log }));
    const paypal = createFakePayPal({});
    await listDisputeViews(SESSION, "open", deps([live()], { paypal, demoMode: true, log }));
    expect(paypal.request).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("ignores an unusable date from PayPal", async () => {
    const paypal = createFakePayPal({ [getKey]: { dispute_id: "PP-D-1", status: "OPEN", seller_response_due_date: "tomorrow-ish" } });
    const [view] = await listDisputeViews(SESSION, "open", deps([live()], { paypal }));
    expect(view?.deadlineAt).toBe("2026-11-20T00:00:00.000Z");
  });

  it("does not hide a bug behind the fallback", async () => {
    const paypal = createFakePayPal({ [getKey]: new TypeError("bug") });
    await expect(listDisputeViews(SESSION, "open", deps([live()], { paypal }))).rejects.toThrow("bug");
  });
});

describe("getDisputeView", () => {
  it("returns the view and its order, and null when not visible", async () => {
    const records = [makeRecord(analysed({ id: "mine", orderId: "m-o" })), makeRecord(analysed({ id: "theirs", orderId: "t-o", sessionId: OTHER_SESSION }))];
    expect((await getDisputeView("mine", SESSION, deps(records)))?.view.id).toBe("mine");
    expect((await getDisputeView("mine", SESSION, deps(records)))?.order.id).toBe("m-o");
    expect(await getDisputeView("theirs", SESSION, deps(records))).toBeNull();
    expect(await getDisputeView("nope", SESSION, deps(records))).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("disputes read repo against the live database", () => {
  afterAll(async () => {
    const { closeDb } = await import("@/db/client");
    await closeDb();
  });

  it("a fresh session sees exactly the 3 open and 5 resolved seeded disputes, with offsets applied", async () => {
    const { createDrizzleDisputesReadRepo } = await import("../repo");
    const sessionId = `read-test-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const d = { repo: createDrizzleDisputesReadRepo(), paypal: null, demoMode: false, now: () => now };

    const open = await listDisputeViews(sessionId, "open", d);
    const resolved = await listDisputeViews(sessionId, "resolved", d);

    expect(open).toHaveLength(3);
    expect(resolved).toHaveLength(5);
    const hoursLeft = open.map((v) => Math.round((new Date(v.deadlineAt).getTime() - now.getTime()) / HOUR));
    expect(hoursLeft).toEqual([40, 48, 72]); // SEED-E, SEED-D, SEED-C: soonest first
    expect(open.every((v) => v.isDemo && v.analysis !== null && !v.analysis.aiUnavailable)).toBe(true);
    expect(resolved.map((v) => v.outcome).sort()).toEqual(["lost", "refunded", "refunded", "won", "won"]);
    expect(resolved.map((v) => v.resolvedAt)).toEqual([...resolved.map((v) => v.resolvedAt)].sort().reverse());

    const first = open[0];
    expect((await getDisputeView(first!.id, sessionId, d))?.order.id).toBe(first!.orderId);
    expect(await getDisputeView("not-a-uuid", sessionId, d)).toBeNull();
    expect(await getDisputeView(randomUUID(), sessionId, d)).toBeNull();
  });
});
