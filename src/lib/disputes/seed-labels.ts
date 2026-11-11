/**
 * Labels for the seeded disputes (SEED-C, SEED-D, SEED-E and the history H1 to H5) and for a session's
 * own "Start demo" copies of the three open ones ("Your copy of SEED-C"). The database has no label
 * column: seed ids are deterministic and so are copy ids (`demoCopyId`), so the label is looked up.
 * Only seeded disputes and their copies ever match; a real dispute gets no label.
 */
import { demoCopyId, SHARED_EXAMPLE_KEYS } from "@/lib/demo/ids";
import { seedId } from "@/seed/ids";

export const SEED_DISPUTE_KEYS = ["SEED-C", "SEED-D", "SEED-E", "H1", "H2", "H3", "H4", "H5"] as const;

const SHARED_BY_ID: ReadonlyMap<string, string> = new Map(SEED_DISPUTE_KEYS.map((key) => [seedId("dispute", key), key]));

/** "SEED-C" for that shared seed, "Your copy of SEED-C" for this session's copy of it, else null. */
export function seedDisputeLabel(disputeId: string, sessionId: string): string | null {
  const shared = SHARED_BY_ID.get(disputeId);
  if (shared) return shared;
  for (const key of SHARED_EXAMPLE_KEYS) {
    if (demoCopyId(sessionId, seedId("dispute", key)) === disputeId) return `Your copy of ${key}`;
  }
  return null;
}

/** The labels of the seeded disputes (and this session's copies) among `disputeIds`, as a plain object. */
export function seedDisputeLabels(disputeIds: readonly string[], sessionId: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const id of disputeIds) {
    const label = seedDisputeLabel(id, sessionId);
    if (label) labels[id] = label;
  }
  return labels;
}
