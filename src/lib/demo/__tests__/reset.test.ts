import { describe, expect, it, vi } from "vitest";
import { createFakeSimulationRepo, makeRecord, analysed } from "@/lib/disputes/__tests__/fakes";
import type { DisputeRecord } from "@/lib/disputes/types";
import { startDemo } from "../copies";
import { sharedExampleId } from "../ids";
import { RESET_COOLDOWN_MS, RESET_TOOL_GLOBAL, RESET_TOOL_SESSION, resetDemo, restartMyDemo, type RestartStore } from "../reset";
import { A, B, NOW, SEED_DISPUTE_C, SEED_DISPUTE_D, SEED_DISPUTE_E, SEED_ORDER, SEED_RESOLVED, SEED_SESSION, addVisitor, createFakeStores, makeWorld, sessionRows, snapshot } from "./world";

const at = (offsetMs: number) => () => new Date(NOW.getTime() + offsetMs);

/** A seeded world with two visitors who have each used the demo. */
function busyWorld() {
  const world = makeWorld();
  addVisitor(world, A);
  addVisitor(world, B);
  world.weights = { firstTimeHighValue: 23, proposalCreatedAt: null, counter: 7 }; // an approved change and 7 counted outcomes
  world.insightsFingerprint = "after-visitors";
  return world;
}

const seedOnly = () => snapshot(makeWorld());

describe("resetDemo (global)", () => {
  it("deletes every visitor's data and restores the seed: weights, pending proposal, counter, insights cache", async () => {
    const stores = createFakeStores(busyWorld());
    const result = await resetDemo(A, { store: stores.reset, now: at(0) });

    expect(result.kind).toBe("reset");
    const after = snapshot(stores.world);
    // Exactly the seed again (the one new activity row is the reset's own audit row).
    expect(after.orders).toEqual(seedOnly().orders);
    expect(after.artefacts).toEqual(seedOnly().artefacts);
    expect(after.disputes).toEqual(seedOnly().disputes);
    expect(after.approvals).toEqual([]);
    expect(after.executions).toEqual([]);
    expect(after.outcomes).toEqual(seedOnly().outcomes);
    expect(stores.world.activity.filter((a) => a.sessionId !== SEED_SESSION).map((a) => a.toolName)).toEqual([RESET_TOOL_GLOBAL]);
    expect(stores.world.activity.filter((a) => a.sessionId === SEED_SESSION)).toHaveLength(2);
    expect(stores.world.weights).toEqual({ firstTimeHighValue: 20, proposalCreatedAt: new Date(NOW.getTime() - 6 * 3_600_000).toISOString(), counter: 0 });
    expect(stores.world.insightsFingerprint).toBe("seed-fingerprint");
  });

  it("removes every session's copies, simulated disputes, approvals, executions and outcomes (by dispute, not by the order's is_seed)", async () => {
    const stores = createFakeStores(busyWorld());
    expect(sessionRows(stores.world, A).disputes).toBe(3);
    await resetDemo(A, { store: stores.reset, now: at(0) });
    for (const s of [A, B]) expect(sessionRows(stores.world, s)).toEqual({ orders: 0, disputes: 0, approvals: 0, executions: 0, outcomes: 0, activity: s === A ? 1 : 0 });
    expect(stores.world.disputes.filter((d) => d.orderId === SEED_ORDER).map((d) => d.id).sort()).toEqual([SEED_DISPUTE_C, SEED_DISPUTE_D, SEED_DISPUTE_E, SEED_RESOLVED].sort());
  });

  it("reports what visitors had, not the seed rows it re-wrote", async () => {
    const stores = createFakeStores(busyWorld());
    const result = await resetDemo(A, { store: stores.reset, now: at(0) });
    expect(result).toEqual({
      kind: "reset",
      deleted: { orders: 2, evidenceArtefacts: 4, disputes: 6, approvals: 4, executions: 4, outcomes: 4, activity: 6 },
    });
  });

  it("never touches the global daily LLM counter or any per-session rate-limit row", async () => {
    const stores = createFakeStores(busyWorld());
    const before = { daily: { ...stores.world.llmDaily }, rate: { ...stores.world.llmRate } };
    await resetDemo(A, { store: stores.reset, now: at(0) });
    expect(stores.world.llmDaily).toEqual(before.daily);
    expect(stores.world.llmRate).toEqual(before.rate);
  });

  it("works in a fixed order inside one transaction: lock, cooldown check, wipe, seed, then the audit row", async () => {
    const stores = createFakeStores(busyWorld());
    await resetDemo(A, { store: stores.reset, now: at(0) });
    expect(stores.calls).toEqual(["lock", "latestGlobalReset", "wipe", "seed", "log"]);
  });

  it("writes one merchant_action row, reset_demo_global, by the caller, with a time of its own", async () => {
    const stores = createFakeStores(busyWorld());
    await resetDemo(B, { store: stores.reset, now: at(0) });
    const row = stores.world.activity.find((a) => a.toolName === RESET_TOOL_GLOBAL);
    expect(row).toMatchObject({ sessionId: B, status: "success", createdAt: NOW.toISOString() });
  });

  it("is a clean no-op on an already-seeded database (idempotent)", async () => {
    const stores = createFakeStores(makeWorld());
    const first = await resetDemo(A, { store: stores.reset, now: at(0) });
    expect(first).toMatchObject({ kind: "reset", deleted: { orders: 0, disputes: 0, approvals: 0, executions: 0, outcomes: 0, activity: 0 } });
    const second = await resetDemo(A, { store: stores.reset, now: at(RESET_COOLDOWN_MS) });
    expect(second.kind).toBe("reset");
    expect(snapshot(stores.world).disputes).toEqual(seedOnly().disputes);
    expect(stores.world.activity.filter((a) => a.toolName === RESET_TOOL_GLOBAL)).toHaveLength(1); // the older audit row was cleared with the rest
  });
});

describe("resetDemo: the 10-second cooldown", () => {
  it("a second reset within 10 s is refused with the seconds left, and nothing is deleted, seeded or logged", async () => {
    const stores = createFakeStores(busyWorld());
    await resetDemo(A, { store: stores.reset, now: at(0) });
    addVisitor(stores.world, B); // new work arrives between the two clicks
    const before = snapshot(stores.world);
    stores.calls.length = 0;

    const second = await resetDemo(B, { store: stores.reset, now: at(3_000) });
    expect(second).toEqual({ kind: "cooldown", retryAfterSeconds: 7 });
    expect(snapshot(stores.world)).toEqual(before);
    expect(stores.calls).toEqual(["lock", "latestGlobalReset"]); // checked, and stopped
  });

  it("the cooldown is global: it looks at the latest reset from ANY session", async () => {
    const stores = createFakeStores(busyWorld());
    await resetDemo(A, { store: stores.reset, now: at(0) });
    expect((await resetDemo(B, { store: stores.reset, now: at(1) })).kind).toBe("cooldown");
  });

  it("rounds the wait up and is never below one second", async () => {
    const stores = createFakeStores(makeWorld());
    await resetDemo(A, { store: stores.reset, now: at(0) });
    expect(await resetDemo(A, { store: stores.reset, now: at(9_999) })).toEqual({ kind: "cooldown", retryAfterSeconds: 1 });
    expect(await resetDemo(A, { store: stores.reset, now: at(500) })).toEqual({ kind: "cooldown", retryAfterSeconds: 10 });
  });

  it("allows a reset again at exactly 10 s", async () => {
    const stores = createFakeStores(makeWorld());
    await resetDemo(A, { store: stores.reset, now: at(0) });
    expect((await resetDemo(A, { store: stores.reset, now: at(RESET_COOLDOWN_MS) })).kind).toBe("reset");
  });

  it("a session restart does not start the global cooldown", async () => {
    const stores = createFakeStores(busyWorld());
    await restartMyDemo(A, { store: stores.restart, now: at(0) });
    expect((await resetDemo(B, { store: stores.reset, now: at(1) })).kind).toBe("reset");
  });

  it("and a restart by the same session cannot erase the cooldown marker: reset, restart, reset is still refused", async () => {
    const stores = createFakeStores(busyWorld());
    await resetDemo(A, { store: stores.reset, now: at(0) });
    await restartMyDemo(A, { store: stores.restart, now: at(1_000) });
    expect(stores.world.activity.filter((r) => r.toolName === RESET_TOOL_GLOBAL)).toHaveLength(1); // the system's audit row survives the restart
    expect(await resetDemo(A, { store: stores.reset, now: at(2_000) })).toEqual({ kind: "cooldown", retryAfterSeconds: 8 });
  });
});

describe("resetDemo: atomic (all or nothing)", () => {
  it.each([["wipe"], ["seed"], ["log"]] as const)("a failure in %s leaves every table exactly as it was and propagates the error", async (op) => {
    const stores = createFakeStores(busyWorld());
    const before = snapshot(stores.world);
    const afterReset = vi.fn(async () => undefined);
    stores.failOn(op);

    await expect(resetDemo(A, { store: stores.reset, now: at(0), afterReset })).rejects.toThrow(`injected failure in ${op}`);

    expect(snapshot(stores.world)).toEqual(before); // visitor data still there, seed untouched, no audit row
    expect(afterReset).not.toHaveBeenCalled();
  });

  it("a failed reset does not start the cooldown, so the retry goes straight through", async () => {
    const stores = createFakeStores(busyWorld());
    stores.failOn("seed");
    await expect(resetDemo(A, { store: stores.reset, now: at(0) })).rejects.toThrow();
    expect((await resetDemo(A, { store: stores.reset, now: at(1) })).kind).toBe("reset");
  });
});

describe("resetDemo: after the commit", () => {
  it("refreshes the Insights summary once, for the caller, only after a successful reset", async () => {
    const stores = createFakeStores(busyWorld());
    const afterReset = vi.fn(async () => undefined);
    await resetDemo(A, { store: stores.reset, now: at(0), afterReset });
    expect(afterReset).toHaveBeenCalledTimes(1);
    expect(afterReset).toHaveBeenCalledWith(A);

    await resetDemo(A, { store: stores.reset, now: at(1_000), afterReset }); // cooldown
    expect(afterReset).toHaveBeenCalledTimes(1);
  });

  it("a failing refresh does not undo or fail the reset", async () => {
    const stores = createFakeStores(busyWorld());
    const result = await resetDemo(A, { store: stores.reset, now: at(0), afterReset: async () => { throw new Error("model down"); } });
    expect(result.kind).toBe("reset");
    expect(snapshot(stores.world).disputes).toEqual(seedOnly().disputes);
  });
});

describe("restartMyDemo (session-scoped)", () => {
  it("deletes only the caller's orders, disputes, evidence, approvals, executions, outcomes and activity", async () => {
    const stores = createFakeStores(busyWorld());
    const result = await restartMyDemo(A, { store: stores.restart, now: at(0) });
    expect(result).toEqual({ kind: "restarted", deleted: { orders: 1, evidenceArtefacts: 2, disputes: 3, approvals: 2, executions: 2, outcomes: 2, activity: 3 } });
    expect(sessionRows(stores.world, A)).toEqual({ orders: 0, disputes: 0, approvals: 0, executions: 0, outcomes: 0, activity: 1 }); // 1 = the restart's own audit row
  });

  it("session A restarting leaves session B and the seed exactly as they were", async () => {
    const stores = createFakeStores(busyWorld());
    const before = stores.world;
    const bBefore = sessionRows(before, B);
    const seedBefore = {
      orders: before.orders.filter((o) => o.isSeed).map((o) => o.id),
      disputes: before.disputes.filter((d) => d.isSeed).map((d) => d.id),
      artefacts: before.artefacts.filter((a) => a.id.startsWith("seed")).map((a) => a.id),
      outcomes: before.outcomes.filter((o) => o.id.startsWith("seed")).map((o) => o.id),
      activity: before.activity.filter((a) => a.sessionId === SEED_SESSION).map((a) => a.id),
    };

    await restartMyDemo(A, { store: stores.restart, now: at(0) });

    const w = stores.world;
    expect(sessionRows(w, B)).toEqual(bBefore);
    expect({
      orders: w.orders.filter((o) => o.isSeed).map((o) => o.id),
      disputes: w.disputes.filter((d) => d.isSeed).map((d) => d.id),
      artefacts: w.artefacts.filter((a) => a.id.startsWith("seed")).map((a) => a.id),
      outcomes: w.outcomes.filter((o) => o.id.startsWith("seed")).map((o) => o.id),
      activity: w.activity.filter((a) => a.sessionId === SEED_SESSION).map((a) => a.id),
    }).toEqual(seedBefore);
  });

  it("does not touch the shared weights, the proposal, the counter, the insights cache, or any LLM budget row", async () => {
    const stores = createFakeStores(busyWorld());
    const shared = () => ({ weights: { ...stores.world.weights }, fp: stores.world.insightsFingerprint, daily: { ...stores.world.llmDaily }, rate: { ...stores.world.llmRate } });
    const before = shared();
    await restartMyDemo(A, { store: stores.restart, now: at(0) });
    expect(shared()).toEqual(before);
    expect(stores.world.weights.counter).toBe(7); // the counter keeps counting; it is never decremented
  });

  it("is idempotent: a second restart removes nothing and leaves the same state (one audit row)", async () => {
    const stores = createFakeStores(busyWorld());
    await restartMyDemo(A, { store: stores.restart, now: at(0) });
    const once = snapshot(stores.world);

    const second = await restartMyDemo(A, { store: stores.restart, now: at(5_000) });
    expect(second.deleted).toEqual({ orders: 0, evidenceArtefacts: 0, disputes: 0, approvals: 0, executions: 0, outcomes: 0, activity: 1 }); // only the previous audit row
    const twice = snapshot(stores.world);
    expect({ ...twice, activity: twice.activity.length }).toEqual({ ...once, activity: once.activity.length });
    expect(stores.world.activity.filter((a) => a.sessionId === A && a.toolName === RESET_TOOL_SESSION)).toHaveLength(1);
  });

  it("a session with nothing to clear still succeeds", async () => {
    const stores = createFakeStores(busyWorld());
    const result = await restartMyDemo("brand-new-session", { store: stores.restart, now: at(0) });
    expect(result.deleted).toEqual({ orders: 0, evidenceArtefacts: 0, disputes: 0, approvals: 0, executions: 0, outcomes: 0, activity: 0 });
  });

  it("is atomic: a failure after the delete (while logging) rolls the delete back", async () => {
    const stores = createFakeStores(busyWorld());
    const before = snapshot(stores.world);
    stores.failOn("log");
    await expect(restartMyDemo(A, { store: stores.restart, now: at(0) })).rejects.toThrow("injected failure in log");
    expect(snapshot(stores.world)).toEqual(before);
  });

  it("logs a merchant_action row, reset_demo_session, by the caller", async () => {
    const stores = createFakeStores(busyWorld());
    await restartMyDemo(A, { store: stores.restart, now: at(0) });
    expect(stores.world.activity.filter((a) => a.toolName === RESET_TOOL_SESSION)).toEqual([expect.objectContaining({ sessionId: A, status: "success", createdAt: NOW.toISOString() })]);
  });
});

describe("after a restart, Start demo recreates the three copies", () => {
  const ORDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const seedOpen = (key: "SEED-C" | "SEED-D" | "SEED-E", hours: number): DisputeRecord =>
    makeRecord(analysed({ id: sharedExampleId(key), orderId: ORDER, isSeed: true, isDemo: true, sessionId: null, deadlineOffsetHours: hours, deadlineAt: "2099-01-01T00:00:00Z" }));

  it("session A: start, restart, start again -> three new copies, while B's copies are never affected", async () => {
    const records = [seedOpen("SEED-C", 72), seedOpen("SEED-D", 48), seedOpen("SEED-E", 40)];
    const repo = createFakeSimulationRepo(records, records.map((r) => r.order));
    const deps = { repo, now: () => NOW };

    const aFirst = await startDemo(A, deps);
    const bFirst = await startDemo(B, deps);
    expect(aFirst).toMatchObject({ kind: "ok", created: 3 });
    expect(bFirst).toMatchObject({ kind: "ok", created: 3 });
    expect(await startDemo(A, deps)).toMatchObject({ created: 0 }); // idempotent before the restart

    // "Restart my demo" for A, applied to the same dispute rows the Start demo repo holds (in place: the repo closes over the array).
    const store: RestartStore = {
      transaction: async (fn) =>
        fn({
          deleteSessionData: async (s) => {
            let removed = 0;
            for (let i = repo.records.length - 1; i >= 0; i--) {
              const d = repo.records[i]!.dispute;
              if (d.sessionId === s && !d.isSeed) {
                repo.records.splice(i, 1);
                removed++;
              }
            }
            return { orders: 0, evidenceArtefacts: 0, disputes: removed, approvals: 0, executions: 0, outcomes: 0, activity: 0 };
          },
          log: async () => undefined,
        }),
    };
    const restarted = await restartMyDemo(A, { store, now: () => NOW });
    expect(restarted.deleted.disputes).toBe(3);
    expect(repo.records.filter((r) => r.dispute.sessionId === B)).toHaveLength(3); // B untouched
    expect(repo.records.filter((r) => r.dispute.isSeed)).toHaveLength(3); // seeds untouched

    const aAgain = await startDemo(A, deps);
    expect(aAgain).toMatchObject({ kind: "ok", created: 3 }); // fresh copies, same deterministic ids
    expect(repo.records.filter((r) => r.dispute.sessionId === A)).toHaveLength(3);
    if (aAgain.kind === "ok" && aFirst.kind === "ok") expect(aAgain.copies.map((c) => c.disputeId)).toEqual(aFirst.copies.map((c) => c.disputeId));
  });
});
