import { createHash } from "node:crypto";

/**
 * Stable IDs for seed records.
 *
 * The schema has no "seed id" column, so every seed row gets a deterministic UUID (version 5,
 * SHA-1 of namespace + name). The same seed key always maps to the same primary key, which makes
 * `INSERT ... ON CONFLICT (id) DO UPDATE` a true upsert-by-seed-ID with no schema change.
 */
const SEED_NAMESPACE = "6f1d5a3e-2c4b-4f7a-9d1e-5b8c0a7e3d21";

export function uuidV5(name: string, namespace: string = SEED_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export type SeedKind =
  | "settings"
  | "weights"
  | "order"
  | "artefact"
  | "dispute"
  | "outcome"
  | "insights"
  | "activity";

export const seedId = (kind: SeedKind, key: string): string => uuidV5(`${kind}:${key}`);
