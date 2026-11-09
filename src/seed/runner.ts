/**
 * Idempotent seed runner.
 *
 * Every seed row has a deterministic UUID (see ./ids), so each insert is
 * `INSERT ... ON CONFLICT (id) DO UPDATE`: running it twice leaves identical row counts, and
 * running it after editing the seed data updates the rows in place. Everything happens in one
 * transaction, so a failure leaves the database untouched.
 *
 * It only ever writes seed rows. It does not delete anything, including approval records or
 * executions a user created against a seed dispute; clearing those is Reset demo's job (M4-05).
 *
 * No LLM calls and no network calls happen here.
 */
import { getTableColumns, sql } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import {
  agentActivity,
  disputeOutcomes,
  disputes,
  evidenceArtefacts,
  insightsCache,
  orders,
  settings,
  signalWeights,
} from "../db/schema";
import { buildSeedActivity } from "./activity";
import { assertSeedConsistency, buildSeedBundle } from "./data";

export interface SeedSummary {
  /** Rows written (inserted or updated) per table in this run. */
  upserted: Record<string, number>;
}

/** `SET col = excluded.col` for every column except the primary key. */
function excludedSet<T extends PgTable>(table: T): PgUpdateSetSource<T> {
  const entries = Object.entries(getTableColumns(table))
    .filter(([key]) => key !== "id")
    .map(([key, column]) => [key, sql.raw(`excluded."${column.name}"`)] as const);
  return Object.fromEntries(entries) as PgUpdateSetSource<T>;
}

/** Anything the seed can write through: the database client or an open transaction. */
export type SeedWriter = Pick<Db, "insert">;

export async function runSeed(db: Db, options: { now?: Date } = {}): Promise<SeedSummary> {
  let summary: SeedSummary = { upserted: {} };
  await db.transaction(async (tx) => {
    summary = await seedInto(tx, options.now ?? new Date());
  });
  return summary;
}

/**
 * Upsert every seed row through `tx`. The caller owns the transaction, so Reset demo can delete and
 * re-seed atomically. Throws (before any write) if the seed data disagrees with the spec.
 */
export async function seedInto(tx: SeedWriter, now: Date): Promise<SeedSummary> {
  const bundle = buildSeedBundle(now);
  assertSeedConsistency(bundle);

  const upserted: Record<string, number> = {};

  // Parents before children, so foreign keys are always satisfied.
  await tx
    .insert(signalWeights)
    .values(bundle.weights)
    .onConflictDoUpdate({ target: signalWeights.id, set: excludedSet(signalWeights) });
  upserted.signal_weights = 1;

  await tx
    .insert(settings)
    .values(bundle.settings)
    .onConflictDoUpdate({ target: settings.id, set: excludedSet(settings) });
  upserted.settings = 1;

  await tx
    .insert(orders)
    .values(bundle.orders)
    .onConflictDoUpdate({ target: orders.id, set: excludedSet(orders) });
  upserted.orders = bundle.orders.length;

  await tx
    .insert(evidenceArtefacts)
    .values(bundle.artefacts)
    .onConflictDoUpdate({ target: evidenceArtefacts.id, set: excludedSet(evidenceArtefacts) });
  upserted.evidence_artefacts = bundle.artefacts.length;

  await tx
    .insert(disputes)
    .values(bundle.disputes)
    .onConflictDoUpdate({ target: disputes.id, set: excludedSet(disputes) });
  upserted.disputes = bundle.disputes.length;

  await tx
    .insert(disputeOutcomes)
    .values(bundle.outcomes)
    .onConflictDoUpdate({ target: disputeOutcomes.id, set: excludedSet(disputeOutcomes) });
  upserted.dispute_outcomes = bundle.outcomes.length;

  await tx
    .insert(insightsCache)
    .values(bundle.insights)
    .onConflictDoUpdate({ target: insightsCache.id, set: excludedSet(insightsCache) });
  upserted.insights_cache = 1;

  // Last: they reference seeded orders and disputes.
  const activity = buildSeedActivity(now);
  await tx
    .insert(agentActivity)
    .values(activity)
    .onConflictDoUpdate({ target: agentActivity.id, set: excludedSet(agentActivity) });
  upserted.agent_activity = activity.length;

  return { upserted };
}
