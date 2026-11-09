/** Drizzle evidence repository. Append-only by construction: insert and select, nothing else. */
import { asc, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { evidenceArtefacts } from "@/db/schema";
import type { EvidenceRepo } from "./assembler";

export function createDrizzleEvidenceRepo(db: Db = getDb()): EvidenceRepo {
  return {
    async insertArtefacts(rows) {
      if (rows.length === 0) return [];
      return db.insert(evidenceArtefacts).values(rows).returning();
    },
    getEvidenceByOrderId: (orderId) =>
      db.select().from(evidenceArtefacts).where(eq(evidenceArtefacts.orderId, orderId)).orderBy(asc(evidenceArtefacts.createdAt), asc(evidenceArtefacts.artefactType)),
  };
}
