import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "@/lib/activity/queries";
import { addToast, MAX_TOASTS, removeToast, toastDurationMs, type ToastItem } from "@/lib/toast";
import { loadDashboard, type DashboardRepo } from "../load";
import { computeDashboardMetrics, type DisputeOutcomeRow, type OrderRow } from "../metrics";
import { donutSegments, donutSummary } from "../present";

const order = (amountUsd: number, verdict: OrderRow["verdict"], isSeed = false): OrderRow => ({ amountUsd, verdict, isSeed });
const outcome = (o: DisputeOutcomeRow["outcome"], amountUsd: number, simulated = false, isSeed = false): DisputeOutcomeRow => ({ outcome: o, amountUsd, simulated, isSeed });

/** The seeded state: SEED-F ($320, Hold) and H1-H5 (two won, one lost, two refunded). */
const SEED_ORDERS: OrderRow[] = [order(85, "ship", true), order(210, "verify", true), order(60, "ship", true), order(150, "verify", true), order(320, "hold", true)];
const SEED_OUTCOMES: DisputeOutcomeRow[] = [outcome("won", 180, false, true), outcome("won", 95, false, true), outcome("lost", 210, false, true), outcome("refunded", 38, false, true), outcome("refunded", 42, false, true)];

describe("computeDashboardMetrics (REQ-DASH-01)", () => {
  it("the seeded state: Value under review = $320 (SEED-F), 2 won, 2 refunds x $20, no simulated part", () => {
    const m = computeDashboardMetrics(SEED_ORDERS, SEED_OUTCOMES, 20);
    expect(m.value_under_review).toEqual({ amountUsd: 320, orderCount: 1, includesDemoData: true });
    expect(m.disputes_won).toEqual({ count: 2, amountUsd: 275, includesDemoData: true });
    expect(m.chargeback_fees_avoided).toEqual({ count: 2, feeUsd: 20, amountUsd: 40, includesDemoData: true });
    expect(m.dollars_protected).toEqual({ amountUsd: 275, includesDemoData: true });
    expect(m.dollars_protected_simulated.amountUsd).toBe(0);
  });

  it("no double counting: fees avoided are the FEE only and never enter Dollars protected", () => {
    const m = computeDashboardMetrics([], [outcome("won", 100), outcome("refunded", 500)], 20);
    expect(m.dollars_protected.amountUsd).toBe(100); // the refunded $500 is not protected
    expect(m.chargeback_fees_avoided.amountUsd).toBe(20); // one refund x $20, not $500
    expect(m.disputes_won.amountUsd).toBe(100);
  });

  it("Dollars protected counts WON disputes only, and splits out the simulated part", () => {
    const m = computeDashboardMetrics([], [outcome("won", 145, true), outcome("won", 100, false), outcome("lost", 999, true), outcome("refunded", 38, true)], 20);
    expect(m.dollars_protected.amountUsd).toBe(245);
    expect(m.dollars_protected_simulated.amountUsd).toBe(145);
  });

  it("the fee comes from the caller (CHARGEBACK_FEE_USD), not a constant", () => {
    const m = computeDashboardMetrics([], [outcome("refunded", 10), outcome("refunded", 10), outcome("refunded", 10)], 17.5);
    expect(m.chargeback_fees_avoided).toMatchObject({ count: 3, feeUsd: 17.5, amountUsd: 52.5 });
  });

  it("Value under review sums Hold orders only", () => {
    const m = computeDashboardMetrics([order(100, "hold"), order(50.25, "hold"), order(999, "verify"), order(999, "ship"), order(999, null)], [], 20);
    expect(m.value_under_review).toEqual({ amountUsd: 150.25, orderCount: 2, includesDemoData: false });
  });

  it("verdict distribution counts scored orders only, and flags demo data only when a seeded order is in it", () => {
    const own = computeDashboardMetrics([order(10, "ship"), order(10, "ship"), order(10, "hold"), order(10, null)], [], 20);
    expect(own.verdict_distribution).toEqual({ ship: 2, verify: 0, hold: 1, total: 3, includesDemoData: false });
    expect(computeDashboardMetrics(SEED_ORDERS, [], 20).verdict_distribution).toEqual({ ship: 2, verify: 2, hold: 1, total: 5, includesDemoData: true });
  });

  it("an empty session is all zeros, with no demo flag", () => {
    const m = computeDashboardMetrics([], [], 20);
    expect(m.value_under_review).toEqual({ amountUsd: 0, orderCount: 0, includesDemoData: false });
    expect(m.disputes_won.count).toBe(0);
    expect(m.chargeback_fees_avoided.amountUsd).toBe(0);
    expect(m.verdict_distribution.total).toBe(0);
  });

  it("adds cents without floating-point noise", () => {
    const m = computeDashboardMetrics([], [outcome("won", 0.1), outcome("won", 0.2)], 20);
    expect(m.dollars_protected.amountUsd).toBe(0.3);
  });

  it("outcomes still unresolved (null) count nowhere", () => {
    const m = computeDashboardMetrics([], [outcome(null, 500)], 20);
    expect(m.disputes_won.count + m.chargeback_fees_avoided.count).toBe(0);
  });
});

describe("loadDashboard", () => {
  const entry = (n: number): ActivityEntry => ({
    id: `a${n}`,
    createdAt: `2026-11-08T12:0${n}:00.000Z`,
    stepType: "rule_engine",
    toolName: "score_order",
    inputSummary: "in",
    outputSummary: "out",
    durationMs: 3,
    status: "success",
    refOrderId: null,
    refDisputeId: null,
    isDemo: false,
  });

  it("combines the metrics with the most recent activity, scoped to the session, and applies the fee it is given", async () => {
    const asked: string[] = [];
    const repo: DashboardRepo = {
      visibleOrders: async (s) => (asked.push(`orders:${s}`), SEED_ORDERS),
      visibleOutcomes: async (s) => (asked.push(`outcomes:${s}`), SEED_OUTCOMES),
      recentActivity: async (s, count) => (asked.push(`activity:${s}:${count}`), [entry(1), entry(2)]),
    };
    const view = await loadDashboard("session-a", repo, 25);
    expect(asked.sort()).toEqual(["activity:session-a:5", "orders:session-a", "outcomes:session-a"]);
    expect(view.chargeback_fees_avoided).toMatchObject({ count: 2, feeUsd: 25, amountUsd: 50 });
    expect(view.recent_activity.map((e) => e.id)).toEqual(["a1", "a2"]);
    expect(view.value_under_review.amountUsd).toBe(320);
  });
});

describe("donutSegments (REQ-DASH-03)", () => {
  it("arcs run clockwise from 12 o'clock, each starting where the previous ended, and sum to the whole circle", () => {
    const [ship, verify, hold] = donutSegments({ ship: 2, verify: 2, hold: 1 });
    expect([ship?.percent, verify?.percent, hold?.percent]).toEqual([40, 40, 20]);
    expect(ship?.dashOffset).toBeCloseTo(0);
    expect(verify?.dashOffset).toBeCloseTo(-40);
    expect(hold?.dashOffset).toBeCloseTo(-80);
    expect(ship?.dashArray).toBe("40 60");
    expect(hold?.dashArray).toBe("20 80");
  });

  it("uses the app's colour language: green Ship, amber Verify first, red Hold", () => {
    const colours = donutSegments({ ship: 1, verify: 1, hold: 1 }).map((s) => [s.label, s.color]);
    expect(colours).toEqual([["Ship", "#16a34a"], ["Verify first", "#f59e0b"], ["Hold", "#dc2626"]]);
  });

  it("an empty distribution draws no arc", () => {
    expect(donutSegments({ ship: 0, verify: 0, hold: 0 }).map((s) => s.dashArray)).toEqual(["0 100", "0 100", "0 100"]);
    expect(donutSummary({ ship: 0, verify: 0, hold: 0 })).toBe("No scored orders yet.");
  });

  it("describes the chart in words for screen readers", () => {
    expect(donutSummary({ ship: 2, verify: 2, hold: 1 })).toBe("Risk distribution of 5 scored orders: 2 Ship, 2 Verify first, 1 Hold.");
  });
});

describe("toaster rules", () => {
  const list = (n: number): ToastItem[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, tone: "info", title: `t${i + 1}` }));

  it("adds the newest last, defaults to info, and keeps the description only when there is one", () => {
    const out = addToast([], { title: "Saved" }, 1);
    expect(out).toEqual([{ id: 1, tone: "info", title: "Saved" }]);
    expect(addToast(out, { tone: "error", title: "Failed", description: "Try again." }, 2)[1]).toEqual({ id: 2, tone: "error", title: "Failed", description: "Try again." });
  });

  it("never shows more than four: the oldest goes first", () => {
    const out = addToast(list(MAX_TOASTS), { title: "new" }, 99);
    expect(out).toHaveLength(MAX_TOASTS);
    expect(out.map((t) => t.id)).toEqual([2, 3, 4, 99]);
  });

  it("removes one toast by id and leaves the others", () => {
    expect(removeToast(list(3), 2).map((t) => t.id)).toEqual([1, 3]);
  });

  it("errors stay longer than everything else", () => {
    expect(toastDurationMs("error")).toBeGreaterThan(toastDurationMs("success"));
    expect(toastDurationMs("info")).toBe(toastDurationMs("success"));
  });
});
