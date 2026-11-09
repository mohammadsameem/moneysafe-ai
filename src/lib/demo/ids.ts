/**
 * Ids of a session's own demo copies (M3-08). Deterministic: the copy of a seed dispute for one
 * session always has the same primary key, so "Start demo" is idempotent and race-safe with
 * `INSERT ... ON CONFLICT (id) DO NOTHING`, and any page can find the copy of a seed without a
 * lookup column.
 */
import { seedId, uuidV5 } from "@/seed/ids";

/** The open seed disputes that "Start demo" copies, in demo-script order. */
export const SHARED_EXAMPLE_KEYS = ["SEED-C", "SEED-D", "SEED-E"] as const;
export type SharedExampleKey = (typeof SHARED_EXAMPLE_KEYS)[number];

export const sharedExampleId = (key: SharedExampleKey): string => seedId("dispute", key);

export const demoCopyId = (sessionId: string, seedDisputeId: string): string => uuidV5(`demo-copy:${sessionId}:${seedDisputeId}`);
