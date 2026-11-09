/**
 * "Restart my demo" against the real database (the SQL in ../store.ts). It only ever touches rows
 * owned by two random test sessions, and it leaves nothing behind, so it is safe to run alongside
 * real use. The GLOBAL reset is deliberately not run here (it would wipe everyone's data); it is
 * checked by the live QA script, which owns the whole database for its duration.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedId } from "@/seed/ids";

config({ path: ".env.local", quiet: true });

describe.skipIf(!process.env.DATABASE_URL)("restartMyDemo against the live database", () => {
  const A = `restart-live-a-${randomUUID()}`;
  const B = `restart-live-b-${randomUUID()}`;
  const SEED_ORDER = seedId("order", "SEED-A");
  let sqlRef: ReturnType<typeof import("@/db/client").getSql>;

  const insertOrder = async (session: string): Promise<string> => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await sqlRef`
      INSERT INTO orders (id, buyer_email, buyer_is_first_time, shipping_method, billing_country, shipping_country, amount_usd, status, session_id, is_seed, is_demo, created_at, updated_at)
      VALUES (${id}, 'live-test@example.com', true, 'standard', 'US', 'US', 100, 'shipped', ${session}, false, true, ${now}, ${now})`;
    await sqlRef`
      INSERT INTO evidence_artefacts (id, order_id, artefact_type, payload, source, is_mocked, created_at)
      VALUES (${randomUUID()}, ${id}, 'invoice_summary', '{}'::jsonb, 'merchant_input', false, ${now})`;
    return id;
  };
  const insertDispute = async (session: string, orderId: string): Promise<string> => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await sqlRef`
      INSERT INTO disputes (id, order_id, reason, disputed_amount_usd, deadline_at, status, session_id, is_seed, is_demo, created_at, updated_at)
      VALUES (${id}, ${orderId}, 'item_not_received', 100, ${now}, 'open', ${session}, false, true, ${now}, ${now})`;
    return id;
  };
  const insertActivity = async (session: string, refOrder: string | null, refDispute: string | null) => {
    await sqlRef`
      INSERT INTO agent_activity (id, ref_order_id, ref_dispute_id, session_id, step_type, tool_name, input_summary, output_summary, duration_ms, status, created_at)
      VALUES (${randomUUID()}, ${refOrder}, ${refDispute}, ${session}, 'merchant_action', 'restart_live_test', 'in', 'out', 1, 'success', ${new Date().toISOString()})`;
  };

  /** Give a session everything a visitor can create. */
  async function populate(session: string) {
    const { startDemo } = await import("../copies");
    const { createDrizzleSimulationRepo, createDrizzleDisputesRepo } = await import("@/lib/disputes/repo");
    const started = await startDemo(session, { repo: createDrizzleSimulationRepo(), now: () => new Date() });
    if (started.kind !== "ok") throw new Error("seed disputes are missing; run npm run db:seed");

    const order = await insertOrder(session);
    const simulated = await insertDispute(session, order);
    const copyC = started.copies[0]!.disputeId;
    const { approval } = await createDrizzleDisputesRepo().insertApprovalWithExecution({
      disputeId: copyC,
      actionType: "submit_evidence",
      merchantUserId: "demo-merchant",
      payloadHash: "h",
      approvedPayload: { evidences: [] },
      originalDraft: null,
      editedDraft: null,
      paypalRequestId: randomUUID(),
    });
    await sqlRef`
      INSERT INTO dispute_outcomes (id, dispute_id, outcome, risk_score_snapshot, verdict_snapshot, win_probability_snapshot, is_simulated, created_at)
      VALUES (${randomUUID()}, ${copyC}, 'won', 0, 'ship', 0.9, true, ${new Date().toISOString()})`;
    await insertActivity(session, order, null);
    await insertActivity(session, SEED_ORDER, copyC); // points at a SEED order and the session's own dispute
    await sqlRef`INSERT INTO llm_rate_limits (session_id, call_count, window_start) VALUES (${session}, 3, ${new Date().toISOString()})`;
    return { order, simulated, copyC, approvalId: approval.id };
  }

  const rowsOf = async (session: string) => {
    const [r] = await sqlRef<Record<string, number>[]>`
      SELECT
        (SELECT count(*)::int FROM orders WHERE session_id = ${session}) AS orders,
        (SELECT count(*)::int FROM disputes WHERE session_id = ${session}) AS disputes,
        (SELECT count(*)::int FROM evidence_artefacts WHERE order_id IN (SELECT id FROM orders WHERE session_id = ${session})) AS artefacts,
        (SELECT count(*)::int FROM approval_records WHERE dispute_id IN (SELECT id FROM disputes WHERE session_id = ${session})) AS approvals,
        (SELECT count(*)::int FROM action_executions WHERE dispute_id IN (SELECT id FROM disputes WHERE session_id = ${session})) AS executions,
        (SELECT count(*)::int FROM dispute_outcomes WHERE dispute_id IN (SELECT id FROM disputes WHERE session_id = ${session})) AS outcomes,
        (SELECT count(*)::int FROM agent_activity WHERE session_id = ${session}) AS activity,
        (SELECT count(*)::int FROM llm_rate_limits WHERE session_id = ${session}) AS rate_limits`;
    return r!;
  };

  /** Everything a restart must leave alone, as comparable text. */
  const untouched = async () => {
    const seedDisputes = await sqlRef`SELECT id, status, outcome, analysis_computed_at, updated_at FROM disputes WHERE is_seed ORDER BY id`;
    const seedCounts = await sqlRef`SELECT (SELECT count(*)::int FROM orders WHERE is_seed) AS orders,
      (SELECT count(*)::int FROM evidence_artefacts WHERE order_id IN (SELECT id FROM orders WHERE is_seed)) AS artefacts,
      (SELECT count(*)::int FROM agent_activity WHERE session_id = 'seed-demo') AS seed_activity,
      (SELECT count(*)::int FROM dispute_outcomes WHERE dispute_id IN (SELECT id FROM disputes WHERE is_seed)) AS seed_outcomes`;
    // The weights and the pending proposal. NOT the counter or updated_at: repo.live.test.ts bumps and restores them in parallel; the sequential QA script checks the counter exactly.
    const weights = await sqlRef`SELECT id, country_mismatch, first_time_high_value, rush_shipping, high_relative_value, disposable_email, repeated_attempts, is_active, proposed_country_mismatch, proposed_first_time_high_value, proposed_rush_shipping, proposed_high_relative_value, proposed_disposable_email, proposed_repeated_attempts, proposal_reasoning, proposal_created_at FROM signal_weights ORDER BY id`;
    const insights = await sqlRef`SELECT * FROM insights_cache ORDER BY id`;
    return JSON.parse(JSON.stringify({ seedDisputes, seedCounts, weights, insights })) as Record<string, unknown>;
  };

  async function purge(sessions: string[]) {
    const ids = (await sqlRef<{ id: string }[]>`SELECT id FROM disputes WHERE session_id = ANY(${sessions}) AND NOT is_seed`).map((d) => d.id);
    const orderIds = (await sqlRef<{ id: string }[]>`SELECT id FROM orders WHERE session_id = ANY(${sessions}) AND NOT is_seed`).map((o) => o.id);
    await sqlRef`DELETE FROM agent_activity WHERE session_id = ANY(${sessions})`;
    await sqlRef`DELETE FROM llm_rate_limits WHERE session_id = ANY(${sessions})`;
    if (ids.length) {
      await sqlRef`DELETE FROM action_executions WHERE dispute_id = ANY(${ids}::uuid[])`;
      await sqlRef`DELETE FROM approval_records WHERE dispute_id = ANY(${ids}::uuid[])`;
      await sqlRef`DELETE FROM dispute_outcomes WHERE dispute_id = ANY(${ids}::uuid[])`;
      await sqlRef`DELETE FROM disputes WHERE id = ANY(${ids}::uuid[])`;
    }
    if (orderIds.length) {
      await sqlRef`DELETE FROM evidence_artefacts WHERE order_id = ANY(${orderIds}::uuid[])`;
      await sqlRef`DELETE FROM orders WHERE id = ANY(${orderIds}::uuid[])`;
    }
  }

  beforeAll(async () => {
    sqlRef = (await import("@/db/client")).getSql();
  });

  afterAll(async () => {
    await purge([A, B]);
    await (await import("@/db/client")).closeDb();
  });

  it(
    "session A restarts: its rows are gone, session B and the seed are untouched, the shared state and LLM budgets are not modified, and Start demo recreates the copies",
    async () => {
      const { restartMyDemo } = await import("../reset");
      const { createDrizzleRestartStore } = await import("../store");
      const { startDemo } = await import("../copies");
      const { createDrizzleSimulationRepo } = await import("@/lib/disputes/repo");

      await populate(A);
      await populate(B);
      const a0 = await rowsOf(A);
      expect(a0).toMatchObject({ orders: 1, disputes: 4, artefacts: 1, approvals: 1, executions: 1, outcomes: 1, activity: 2, rate_limits: 1 }); // 3 copies + 1 simulated; 2 activity rows inserted above
      const b0 = await rowsOf(B);
      const shared0 = await untouched();

      const result = await restartMyDemo(A, { store: createDrizzleRestartStore() });
      expect(result.deleted).toEqual({ orders: 1, evidenceArtefacts: 1, disputes: 4, approvals: 1, executions: 1, outcomes: 1, activity: 2 });

      expect(await rowsOf(A)).toEqual({ orders: 0, disputes: 0, artefacts: 0, approvals: 0, executions: 0, outcomes: 0, activity: 1, rate_limits: 1 }); // 1 = its reset_demo_session row; the rate-limit row stays
      const reset = await sqlRef`SELECT tool_name, step_type, status FROM agent_activity WHERE session_id = ${A}`;
      expect(reset).toMatchObject([{ tool_name: "reset_demo_session", step_type: "merchant_action", status: "success" }]);

      expect(await rowsOf(B)).toEqual(b0); // session B: every row still there
      expect(await untouched()).toEqual(shared0); // seed disputes, orders, evidence, seed activity, weights + proposal, insights cache

      // Idempotent.
      const again = await restartMyDemo(A, { store: createDrizzleRestartStore() });
      expect(again.deleted).toEqual({ orders: 0, evidenceArtefacts: 0, disputes: 0, approvals: 0, executions: 0, outcomes: 0, activity: 1 });
      expect(await rowsOf(A)).toMatchObject({ disputes: 0, activity: 1 });
      expect(await untouched()).toEqual(shared0);

      // Start demo works again, with fresh copies, and does not disturb B's.
      const restarted = await startDemo(A, { repo: createDrizzleSimulationRepo(), now: () => new Date() });
      expect(restarted).toMatchObject({ kind: "ok", created: 3 });
      expect(await rowsOf(B)).toEqual(b0);
    },
    90_000,
  );
});
