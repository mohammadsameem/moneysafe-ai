import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NO_SESSION_KEY,
  SESSION_CALLS_PER_WINDOW,
  SESSION_WINDOW_MS,
  checkLlmBudget,
  type BudgetOptions,
} from "../rate-limit";

config({ path: ".env.local", quiet: true });

type BudgetDb = NonNullable<BudgetOptions["db"]>;

// ---------------------------------------------------------------------------
// Control flow, with a fake database. The SQL itself is tested against Postgres below.
// ---------------------------------------------------------------------------

type Exec = (query: unknown) => Promise<unknown[]>;

/** A fake db whose transaction behaves like the real one: a throw inside the callback rejects it. */
function fakeDb(execute: Exec) {
  const calls: unknown[] = [];
  const db = {
    transaction: async <T>(fn: (tx: { execute: Exec }) => Promise<T>): Promise<T> =>
      fn({
        execute: async (query) => {
          calls.push(query);
          return execute(query);
        },
      }),
  };
  return { db: db as unknown as BudgetDb, calls };
}

describe("checkLlmBudget (control flow)", () => {
  it("allows a call when both counters take a slot", async () => {
    const { db, calls } = fakeDb(async () => [{ call_count: 1 }]);
    expect(await checkLlmBudget("s1", { db, dailyCap: 5 })).toEqual({ allowed: true });
    expect(calls).toHaveLength(2); // session upsert, then daily upsert
  });

  it("denies with reason 'session' and never touches the daily counter", async () => {
    const { db, calls } = fakeDb(async () => []);
    expect(await checkLlmBudget("s1", { db, dailyCap: 5 })).toEqual({ allowed: false, reason: "session" });
    expect(calls).toHaveLength(1);
  });

  it("denies with reason 'daily' and rejects the transaction so the session increment is rolled back", async () => {
    let n = 0;
    let rolledBack = false;
    const db = {
      transaction: async (fn: (tx: { execute: Exec }) => Promise<void>) => {
        try {
          await fn({ execute: async () => (n++ === 0 ? [{ call_count: 1 }] : []) });
        } catch (err) {
          rolledBack = true; // a real transaction rolls back when the callback throws
          throw err;
        }
      },
    } as unknown as BudgetDb;

    expect(await checkLlmBudget("s1", { db, dailyCap: 5 })).toEqual({ allowed: false, reason: "daily" });
    expect(rolledBack).toBe(true);
  });

  it("lets a database failure propagate (callWithFallback then uses the rule-based result)", async () => {
    const { db } = fakeDb(async () => {
      throw new Error("connection refused");
    });
    await expect(checkLlmBudget("s1", { db })).rejects.toThrow("connection refused");
  });

  it("puts calls without a session id in one shared bucket", async () => {
    const seen: string[] = [];
    const { db } = fakeDb(async (query) => {
      seen.push(JSON.stringify(query));
      return [{ call_count: 1 }];
    });
    await checkLlmBudget(undefined, { db, dailyCap: 5 });
    await checkLlmBudget("   ", { db, dailyCap: 5 });
    expect(seen.filter((q) => q.includes(NO_SESSION_KEY))).toHaveLength(2);
  });

  it("uses 10 calls per hour per session by default", () => {
    expect(SESSION_CALLS_PER_WINDOW).toBe(10);
    expect(SESSION_WINDOW_MS).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// The SQL, against the real database. Isolated by a far-future UTC day and unique session ids,
// and cleaned up afterwards, so real counters are never touched.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.DATABASE_URL)("checkLlmBudget (live database)", () => {
  const run = randomUUID().slice(0, 8);
  const sid = (name: string) => `rl-test-${run}-${name}`;
  // Each test uses its own UTC day in 2099, so daily counters never overlap or touch real ones.
  const dayOf = (i: number) => new Date(Date.UTC(2099, 5, i, 12, 0, 0));

  const sessionCount = async (name: string): Promise<number | null> => {
    const { getSql } = await import("@/db/client");
    const rows = await getSql()<{ call_count: number }[]>`SELECT call_count FROM llm_rate_limits WHERE session_id = ${sid(name)}`;
    return rows[0]?.call_count ?? null;
  };
  const dailyCount = async (date: Date): Promise<number | null> => {
    const { getSql } = await import("@/db/client");
    const rows = await getSql()<{ call_count: number }[]>`SELECT call_count FROM llm_daily_usage WHERE day = ${date.toISOString().slice(0, 10)}`;
    return rows[0]?.call_count ?? null;
  };

  beforeAll(async () => {
    const { getSql } = await import("@/db/client");
    await getSql()`DELETE FROM llm_rate_limits WHERE session_id LIKE ${`rl-test-${run}-%`}`;
  });

  afterAll(async () => {
    const { closeDb, getSql } = await import("@/db/client");
    await getSql()`DELETE FROM llm_rate_limits WHERE session_id LIKE ${`rl-test-${run}-%`}`;
    await getSql()`DELETE FROM llm_daily_usage WHERE day LIKE '2099-%'`;
    await closeDb();
  });

  it("allows calls under both limits and counts each one", async () => {
    const now = dayOf(1);
    for (let i = 0; i < 3; i++) {
      expect(await checkLlmBudget(sid("under"), { now, sessionLimit: 5, dailyCap: 100 })).toEqual({ allowed: true });
    }
    expect(await sessionCount("under")).toBe(3);
    expect(await dailyCount(now)).toBe(3);
  });

  it("denies the call after the session limit and does not increment either counter", async () => {
    const now = dayOf(2);
    for (let i = 0; i < 3; i++) await checkLlmBudget(sid("session"), { now, sessionLimit: 3, dailyCap: 100 });

    expect(await checkLlmBudget(sid("session"), { now, sessionLimit: 3, dailyCap: 100 })).toEqual({ allowed: false, reason: "session" });
    expect(await sessionCount("session")).toBe(3);
    expect(await dailyCount(now)).toBe(3);
  });

  it("denies when the day is full, and leaves the session uncharged (the transaction rolls back)", async () => {
    const now = dayOf(3);
    for (let i = 0; i < 2; i++) await checkLlmBudget(sid("daily-a"), { now, sessionLimit: 10, dailyCap: 2 });

    expect(await checkLlmBudget(sid("daily-b"), { now, sessionLimit: 10, dailyCap: 2 })).toEqual({ allowed: false, reason: "daily" });
    expect(await sessionCount("daily-b")).toBeNull(); // the session row was rolled back, not left at 1
    expect(await dailyCount(now)).toBe(2);
  });

  it("starts a new window once more than an hour has passed", async () => {
    const day = dayOf(4);
    const opts = { sessionLimit: 2, dailyCap: 100 };
    await checkLlmBudget(sid("window"), { ...opts, now: day });
    await checkLlmBudget(sid("window"), { ...opts, now: day });
    expect((await checkLlmBudget(sid("window"), { ...opts, now: day })).allowed).toBe(false);

    // Exactly one hour later the window is still the same one.
    const edge = new Date(day.getTime() + SESSION_WINDOW_MS);
    expect((await checkLlmBudget(sid("window"), { ...opts, now: edge })).allowed).toBe(false);

    // One millisecond past the hour it restarts at 1.
    const after = new Date(day.getTime() + SESSION_WINDOW_MS + 1);
    expect(await checkLlmBudget(sid("window"), { ...opts, now: after })).toEqual({ allowed: true });
    expect(await sessionCount("window")).toBe(1);
    expect(await checkLlmBudget(sid("window"), { ...opts, now: after })).toEqual({ allowed: true });
    expect((await checkLlmBudget(sid("window"), { ...opts, now: after })).allowed).toBe(false);
  });

  it("keeps sessions independent of one another", async () => {
    const now = dayOf(5);
    for (let i = 0; i < 2; i++) await checkLlmBudget(sid("x"), { now, sessionLimit: 2, dailyCap: 100 });
    expect((await checkLlmBudget(sid("x"), { now, sessionLimit: 2, dailyCap: 100 })).allowed).toBe(false);
    expect((await checkLlmBudget(sid("y"), { now, sessionLimit: 2, dailyCap: 100 })).allowed).toBe(true);
  });

  it("cannot be oversubscribed by concurrent calls from one session", async () => {
    const now = dayOf(6);
    const results = await Promise.all(Array.from({ length: 15 }, () => checkLlmBudget(sid("race-session"), { now, sessionLimit: 10, dailyCap: 100 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed && r.reason === "session")).toHaveLength(5);
    expect(await sessionCount("race-session")).toBe(10);
    expect(await dailyCount(now)).toBe(10);
  });

  it("cannot be oversubscribed by concurrent calls from many sessions against the daily cap", async () => {
    const now = dayOf(7);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => checkLlmBudget(sid(`race-day-${i}`), { now, sessionLimit: 10, dailyCap: 8 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(8);
    expect(results.filter((r) => !r.allowed && r.reason === "daily")).toHaveLength(4);
    expect(await dailyCount(now)).toBe(8);
    // The four refused sessions were rolled back and hold no count.
    const { getSql } = await import("@/db/client");
    const [row] = await getSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM llm_rate_limits WHERE session_id LIKE ${`rl-test-${run}-race-day-%`}`;
    expect(row?.n).toBe(8);
  });
});
