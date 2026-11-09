import type { Dispute, EvidenceArtefact, Order } from "@/db/schema";

/** A dispute with the order it belongs to (every dispute has exactly one). */
export interface DisputeRecord {
  dispute: Dispute;
  order: Order;
}

/**
 * Read side of the disputes store. Visibility rule: a dispute is visible to a session when it is
 * seeded (shared demo data) or was created in that session. Anything else looks like it does not
 * exist, so ids cannot be probed.
 */
export interface DisputesReadRepo {
  listVisible(sessionId: string): Promise<DisputeRecord[]>;
  findVisible(id: string, sessionId: string): Promise<DisputeRecord | null>;
  getArtefacts(orderId: string): Promise<EvidenceArtefact[]>;
}
