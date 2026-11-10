/**
 * The human labels of the seeded orders (SEED-A, SEED-B, ..., H1-ORD), keyed by their deterministic ids.
 * The database has no label column, so the UI looks them up here; only seeded orders ever match.
 */
import { seedId } from "./ids";

export const SEED_ORDER_KEYS = ["SEED-A", "SEED-B", "SEED-D-ORD", "SEED-E-ORD", "SEED-F", "H1-ORD", "H2-ORD", "H3-ORD", "H4-ORD", "H5-ORD"] as const;

const BY_ID: ReadonlyMap<string, string> = new Map(SEED_ORDER_KEYS.map((key) => [seedId("order", key), key]));

/** "SEED-B" for the seeded order with that id; null for any other order. */
export const seedOrderLabel = (orderId: string): string | null => BY_ID.get(orderId) ?? null;

/** The labels of the seeded orders among `orderIds`, as a plain object (safe to pass to a client component). */
export function seedOrderLabels(orderIds: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const id of orderIds) {
    const label = BY_ID.get(id);
    if (label) labels[id] = label;
  }
  return labels;
}
