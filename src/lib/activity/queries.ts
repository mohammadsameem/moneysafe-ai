/**
 * Reading the agent activity log (M3-05, REQ-AA-02/03).
 *
 * Visibility: a session sees its own rows plus the seeded demo rows (session `seed-demo`), never
 * another session's. Newest first, 20 per page.
 */
import { and, desc, eq, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { ACTIVITY_STATUSES, ACTIVITY_STEP_TYPES, agentActivity, type AgentActivityRow } from "@/db/schema";
import { SEED_ACTIVITY_SESSION_ID } from "@/seed/activity";

export const ACTIVITY_PAGE_SIZE = 20;
export const ACTIVITY_MAX_PAGE_SIZE = 50;

const uuid = z.string().uuid();

/** Query-string filters for GET /api/activity. Unknown keys are ignored; bad values are rejected. */
export const ActivityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(ACTIVITY_MAX_PAGE_SIZE).default(ACTIVITY_PAGE_SIZE),
  refOrderId: uuid.optional(),
  refDisputeId: uuid.optional(),
  stepType: z.enum(ACTIVITY_STEP_TYPES).optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

export interface ActivityEntry {
  id: string;
  createdAt: string;
  stepType: AgentActivityRow["stepType"];
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  durationMs: number;
  status: AgentActivityRow["status"];
  refOrderId: string | null;
  refDisputeId: string | null;
  /** A seeded demo row (shared by every session). */
  isDemo: boolean;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export function toActivityEntry(row: AgentActivityRow): ActivityEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    stepType: row.stepType,
    toolName: row.toolName,
    inputSummary: row.inputSummary,
    outputSummary: row.outputSummary,
    durationMs: row.durationMs,
    status: row.status,
    refOrderId: row.refOrderId,
    refDisputeId: row.refDisputeId,
    isDemo: row.sessionId === SEED_ACTIVITY_SESSION_ID,
  };
}

/** Builds the WHERE clause. Exported so the visibility rule can be tested on its own. */
export function activityWhere(sessionId: string, q: Omit<ActivityQuery, "page" | "pageSize">): SQL | undefined {
  const filters: (SQL | undefined)[] = [or(eq(agentActivity.sessionId, sessionId), eq(agentActivity.sessionId, SEED_ACTIVITY_SESSION_ID))];
  if (q.refOrderId) filters.push(eq(agentActivity.refOrderId, q.refOrderId));
  if (q.refDisputeId) filters.push(eq(agentActivity.refDisputeId, q.refDisputeId));
  if (q.stepType) filters.push(eq(agentActivity.stepType, q.stepType));
  if (q.status) filters.push(eq(agentActivity.status, q.status));
  return and(...filters);
}

export async function listActivity(sessionId: string, query: Partial<ActivityQuery> = {}, db: Db = getDb()): Promise<ActivityPage> {
  const q = ActivityQuerySchema.parse(query);
  const rows = await db
    .select()
    .from(agentActivity)
    .where(activityWhere(sessionId, q))
    .orderBy(desc(agentActivity.createdAt), desc(agentActivity.id))
    .limit(q.pageSize + 1) // one extra row tells us whether there is another page
    .offset((q.page - 1) * q.pageSize);
  return { entries: rows.slice(0, q.pageSize).map(toActivityEntry), page: q.page, pageSize: q.pageSize, hasMore: rows.length > q.pageSize };
}
