/**
 * An in-memory database for the reset / restart tests. The stores below apply the SAME rules as the
 * SQL in ../store.ts (what is deleted, in what order, what is untouched), and `transaction` rolls the
 * whole world back when the callback throws, like Postgres does. The real SQL is checked against the
 * real database by restart.live.test.ts and the live checks.
 */
import type { ActivityMeta } from "@/lib/activity/logger";
import { EMPTY_COUNTS, RESET_TOOL_GLOBAL, type RestartStore, type ResetStore, type ResetTx, type RestartTx, type WipeCounts } from "../reset";

export const SEED_SESSION = "seed-demo";
export const A = "session-a";
export const B = "session-b";
export const NOW = new Date("2026-11-09T12:00:00.000Z");

interface Order { id: string; sessionId: string | null; isSeed: boolean }
interface Dispute { id: string; orderId: string; sessionId: string | null; isSeed: boolean }
interface Activity { id: string; sessionId: string | null; toolName: string; refDisputeId: string | null; refOrderId: string | null; createdAt: string; status: string }

export interface World {
  orders: Order[];
  artefacts: { id: string; orderId: string }[];
  disputes: Dispute[];
  approvals: { id: string; disputeId: string }[];
  executions: { id: string; disputeId: string }[];
  outcomes: { id: string; disputeId: string }[];
  activity: Activity[];
  weights: { firstTimeHighValue: number; proposalCreatedAt: string | null; counter: number };
  insightsFingerprint: string;
  llmDaily: Record<string, number>;
  llmRate: Record<string, number>;
}

export const SEED_ORDER = "seed-order-1";
export const SEED_DISPUTE_C = "seed-dispute-c";
export const SEED_DISPUTE_D = "seed-dispute-d";
export const SEED_DISPUTE_E = "seed-dispute-e";
export const SEED_RESOLVED = "seed-dispute-h1";

const seedRows = (now: Date): Pick<World, "orders" | "artefacts" | "disputes" | "outcomes" | "activity"> => ({
  orders: [{ id: SEED_ORDER, sessionId: null, isSeed: true }],
  artefacts: [{ id: "seed-art-1", orderId: SEED_ORDER }, { id: "seed-art-2", orderId: SEED_ORDER }],
  disputes: [SEED_DISPUTE_C, SEED_DISPUTE_D, SEED_DISPUTE_E, SEED_RESOLVED].map((id) => ({ id, orderId: SEED_ORDER, sessionId: null, isSeed: true })),
  outcomes: [{ id: "seed-outcome-h1", disputeId: SEED_RESOLVED }],
  activity: [1, 2].map((i) => ({ id: `seed-act-${i}`, sessionId: SEED_SESSION, toolName: "score_order", refDisputeId: null, refOrderId: SEED_ORDER, createdAt: new Date(now.getTime() - i * 3_600_000).toISOString(), status: "success" })),
});

/** The seeded database, plus whatever `visitors` adds. */
export function makeWorld(): World {
  return {
    ...seedRows(new Date("2026-11-09T08:00:00.000Z")),
    approvals: [],
    executions: [],
    weights: { firstTimeHighValue: 20, proposalCreatedAt: "2026-11-09T02:00:00.000Z", counter: 0 },
    insightsFingerprint: "seed-fingerprint",
    llmDaily: { "2026-11-09": 17 },
    llmRate: { [A]: 4, [B]: 2, "idle-session": 10 },
  };
}

/** Everything one visitor session can create: an order with evidence, Start demo copies, a simulated dispute, approvals, outcomes, activity. */
export function addVisitor(w: World, s: string): void {
  const order = `order-${s}`;
  const copyC = `copy-c-${s}`;
  const copyD = `copy-d-${s}`;
  const sim = `sim-${s}`;
  w.orders.push({ id: order, sessionId: s, isSeed: false });
  w.artefacts.push({ id: `art-${s}-1`, orderId: order }, { id: `art-${s}-2`, orderId: order });
  w.disputes.push(
    { id: copyC, orderId: SEED_ORDER, sessionId: s, isSeed: false }, // a Start demo copy: a non-seed dispute on a SEED order
    { id: copyD, orderId: SEED_ORDER, sessionId: s, isSeed: false },
    { id: sim, orderId: order, sessionId: s, isSeed: false },
  );
  w.approvals.push({ id: `appr-${s}-c`, disputeId: copyC }, { id: `appr-${s}-d`, disputeId: copyD });
  w.executions.push({ id: `exec-${s}-c`, disputeId: copyC }, { id: `exec-${s}-d`, disputeId: copyD });
  w.outcomes.push({ id: `out-${s}-c`, disputeId: copyC }, { id: `out-${s}-d`, disputeId: copyD });
  w.activity.push(
    { id: `act-${s}-1`, sessionId: s, toolName: "start_demo", refDisputeId: null, refOrderId: null, createdAt: "2026-11-09T09:00:00.000Z", status: "simulated" },
    { id: `act-${s}-2`, sessionId: s, toolName: "approve_dispute_action", refDisputeId: copyC, refOrderId: SEED_ORDER, createdAt: "2026-11-09T09:01:00.000Z", status: "success" },
    { id: `act-${s}-3`, sessionId: s, toolName: "score_order", refDisputeId: null, refOrderId: order, createdAt: "2026-11-09T09:02:00.000Z", status: "success" },
  );
}

/** A summary of the world, for before/after comparisons. */
export function snapshot(w: World) {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
  return {
    orders: ids(w.orders),
    artefacts: ids(w.artefacts),
    disputes: ids(w.disputes),
    approvals: ids(w.approvals),
    executions: ids(w.executions),
    outcomes: ids(w.outcomes),
    activity: ids(w.activity),
    weights: { ...w.weights },
    insightsFingerprint: w.insightsFingerprint,
    llmDaily: { ...w.llmDaily },
    llmRate: { ...w.llmRate },
  };
}

export const sessionRows = (w: World, s: string) => ({
  orders: w.orders.filter((o) => o.sessionId === s).length,
  disputes: w.disputes.filter((d) => d.sessionId === s).length,
  approvals: w.approvals.filter((a) => a.id.includes(`-${s}-`)).length,
  executions: w.executions.filter((a) => a.id.includes(`-${s}-`)).length,
  outcomes: w.outcomes.filter((a) => a.id.includes(`-${s}-`)).length,
  activity: w.activity.filter((a) => a.sessionId === s).length,
});

function toActivity(meta: ActivityMeta, createdAt: string, id: string): Activity {
  return { id, sessionId: meta.sessionId ?? null, toolName: meta.toolName, refDisputeId: meta.refDisputeId ?? null, refOrderId: meta.refOrderId ?? null, createdAt, status: meta.status };
}

export interface FakeStores {
  world: World;
  reset: ResetStore;
  restart: RestartStore;
  /** The sequence of operations the global reset performed, in order, across all transactions. */
  calls: string[];
  /** Make the next call to this operation throw (to test rollback). */
  failOn(op: "seed" | "log" | "wipe" | "deleteSessionData"): void;
}

export function createFakeStores(world: World): FakeStores {
  const calls: string[] = [];
  let failing: string | null = null;
  let nextId = 1;
  const maybeFail = (op: string) => {
    if (failing === op) {
      failing = null;
      throw new Error(`injected failure in ${op}`);
    }
  };

  const inTransaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = structuredClone(world);
    try {
      return await fn();
    } catch (err) {
      Object.assign(world, before); // ROLLBACK
      throw err;
    }
  };

  const wipeAll = (): WipeCounts => {
    const nonSeedOrders = new Set(world.orders.filter((o) => !o.isSeed).map((o) => o.id));
    const nonSeedDisputes = new Set(world.disputes.filter((d) => !d.isSeed).map((d) => d.id));
    const counts: WipeCounts = {
      orders: nonSeedOrders.size,
      evidenceArtefacts: world.artefacts.filter((a) => nonSeedOrders.has(a.orderId)).length,
      disputes: nonSeedDisputes.size,
      approvals: world.approvals.length,
      executions: world.executions.length,
      outcomes: world.outcomes.filter((o) => nonSeedDisputes.has(o.disputeId)).length,
      activity: world.activity.filter((a) => a.sessionId !== SEED_SESSION).length,
    };
    world.executions = [];
    world.approvals = [];
    world.outcomes = [];
    world.activity = [];
    world.artefacts = [];
    world.disputes = world.disputes.filter((d) => d.isSeed);
    world.orders = world.orders.filter((o) => o.isSeed);
    return counts;
  };

  const deleteSession = (s: string): WipeCounts => {
    const myDisputes = new Set(world.disputes.filter((d) => d.sessionId === s && !d.isSeed).map((d) => d.id));
    const myOrders = new Set(world.orders.filter((o) => o.sessionId === s && !o.isSeed).map((o) => o.id));
    const count = <T>(rows: T[], keep: (r: T) => boolean): [T[], number] => {
      const kept = rows.filter(keep);
      return [kept, rows.length - kept.length];
    };
    const counts = { ...EMPTY_COUNTS };
    [world.executions, counts.executions] = count(world.executions, (r) => !myDisputes.has(r.disputeId));
    [world.approvals, counts.approvals] = count(world.approvals, (r) => !myDisputes.has(r.disputeId));
    [world.outcomes, counts.outcomes] = count(world.outcomes, (r) => !myDisputes.has(r.disputeId));
    [world.activity, counts.activity] = count(
      world.activity,
      (r) => r.toolName === RESET_TOOL_GLOBAL || !(r.sessionId === s || (r.refDisputeId !== null && myDisputes.has(r.refDisputeId)) || (r.refOrderId !== null && myOrders.has(r.refOrderId))),
    );
    [world.artefacts, counts.evidenceArtefacts] = count(world.artefacts, (r) => !myOrders.has(r.orderId));
    [world.disputes, counts.disputes] = count(world.disputes, (r) => !(r.sessionId === s && !r.isSeed));
    [world.orders, counts.orders] = count(world.orders, (r) => !(r.sessionId === s && !r.isSeed));
    return counts;
  };

  return {
    world,
    calls,
    failOn: (op) => {
      failing = op;
    },
    reset: {
      transaction: (fn) =>
        inTransaction(() => {
          const tx: ResetTx = {
            lock: async () => void calls.push("lock"),
            latestGlobalReset: async () => {
              calls.push("latestGlobalReset");
              return world.activity.filter((a) => a.toolName === RESET_TOOL_GLOBAL).map((a) => a.createdAt).sort().at(-1) ?? null;
            },
            wipe: async () => {
              calls.push("wipe");
              maybeFail("wipe");
              return wipeAll();
            },
            seed: async (now) => {
              calls.push("seed");
              const seeded = seedRows(now);
              // wipeAll already cleared the visitor data; seeding writes the canonical rows (upsert by id).
              for (const key of ["orders", "artefacts", "disputes", "outcomes", "activity"] as const) {
                const have = new Set((world[key] as { id: string }[]).map((r) => r.id));
                (world[key] as { id: string }[]).push(...(seeded[key] as { id: string }[]).filter((r) => !have.has(r.id)));
              }
              maybeFail("seed");
              world.weights = { firstTimeHighValue: 20, proposalCreatedAt: new Date(now.getTime() - 6 * 3_600_000).toISOString(), counter: 0 };
              world.insightsFingerprint = "seed-fingerprint";
            },
            log: async (meta, createdAt) => {
              calls.push("log");
              maybeFail("log");
              world.activity.push(toActivity(meta, createdAt, `reset-act-${nextId++}`));
            },
          };
          return fn(tx);
        }),
    },
    restart: {
      transaction: (fn) =>
        inTransaction(() => {
          const tx: RestartTx = {
            deleteSessionData: async (s) => {
              calls.push(`deleteSessionData:${s}`);
              maybeFail("deleteSessionData");
              return deleteSession(s);
            },
            log: async (meta, createdAt) => {
              calls.push("log");
              maybeFail("log");
              world.activity.push(toActivity(meta, createdAt, `restart-act-${nextId++}`));
            },
          };
          return fn(tx);
        }),
    },
  };
}
