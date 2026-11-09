/**
 * Agent Activity logger (REQ-AA-01): one agent_activity row per agent step.
 *
 * Logging is best-effort. A failed write is reported (with the database error code only) and
 * swallowed, so a logging problem can never break an order, a dispute or an LLM call.
 * Summaries are PII-scrubbed and length-capped here, at the single place rows are written.
 */
import { getDb } from "@/db/client";
import { agentActivity, type NewAgentActivityRow } from "@/db/schema";
import { summarize } from "./pii";

export type ActivityStepType = NonNullable<NewAgentActivityRow["stepType"]>;
export type ActivityStatus = NonNullable<NewAgentActivityRow["status"]>;

/**
 * What a caller reports about one step. `LlmActivityEntry` (from callWithFallback) is a
 * structural subset of this, so `logActivity` can be passed straight in as `LlmDeps.logActivity`.
 */
export interface ActivityMeta {
  sessionId?: string | null;
  refOrderId?: string | null;
  refDisputeId?: string | null;
  stepType: ActivityStepType;
  /** Tool or operation name, e.g. "create_order", "risk_explanation". */
  toolName: string;
  /** Summary of the input. Email local parts are replaced with `***` before it is stored. */
  inputSummary: string;
  outputSummary: string;
  durationMs: number;
  status: ActivityStatus;
}

export const TOOL_NAME_MAX_CHARS = 100;

/** Build the row to insert: scrubbed, capped, with a whole-millisecond non-negative duration. */
export function toActivityRow(meta: ActivityMeta): NewAgentActivityRow {
  const duration = Number.isFinite(meta.durationMs) ? Math.max(0, Math.round(meta.durationMs)) : 0;
  return {
    sessionId: meta.sessionId ?? null,
    refOrderId: meta.refOrderId ?? null,
    refDisputeId: meta.refDisputeId ?? null,
    stepType: meta.stepType,
    toolName: summarize(meta.toolName, TOOL_NAME_MAX_CHARS),
    inputSummary: summarize(meta.inputSummary),
    outputSummary: summarize(meta.outputSummary),
    durationMs: duration,
    status: meta.status,
  };
}

export type ActivityInsert = (row: NewAgentActivityRow) => Promise<unknown>;

const warn = (message: string) => console.warn(`[activity] ${message}`);

/**
 * The Postgres error code (e.g. "23503"), if the error carries one. Drizzle wraps driver errors
 * in a DrizzleQueryError whose `cause` is the driver's error, so look there as well. Only the
 * code is read: the message can echo row values.
 */
export function errorCode(err: unknown): string {
  const read = (e: unknown): string =>
    typeof e === "object" && e !== null && "code" in e && (typeof e.code === "string" || typeof e.code === "number")
      ? String(e.code)
      : "";
  const direct = read(err);
  if (direct) return direct;
  return typeof err === "object" && err !== null && "cause" in err ? read(err.cause) : "";
}

/** A logger that writes through `insert`. Never throws. */
export function createActivityLogger(
  insert: ActivityInsert,
  onError: (message: string) => void = warn,
): (meta: ActivityMeta) => Promise<void> {
  return async (meta) => {
    try {
      await insert(toActivityRow(meta));
    } catch (err) {
      const code = errorCode(err);
      onError(`could not write an activity row${code ? ` (code ${code})` : ""}`);
    }
  };
}

/** The real logger: inserts into agent_activity through the pooled database client. */
export const logActivity: (meta: ActivityMeta) => Promise<void> = createActivityLogger(async (row) => {
  await getDb().insert(agentActivity).values(row);
});
