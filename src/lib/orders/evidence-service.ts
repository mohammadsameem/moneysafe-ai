/** Evidence read and buyer-communication append for one order (M3-03). */
import { z } from "zod";
import type { Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import { buildCommunicationArtefact, summarizeEvidence, type EvidenceRepo, type EvidenceSummaryView } from "@/lib/evidence/assembler";
import { computeEvidenceCompleteness } from "@/lib/scoring";

export const CommunicationRequestSchema = z
  .object({
    direction: z.enum(["inbound", "outbound"]),
    subject: z.string().trim().min(1, "is required").max(150, "must be at most 150 characters"),
    body: z.string().trim().min(1, "is required").max(2000, "must be at most 2000 characters"),
    /** Defaults to now. Must not be in the future. */
    sentAt: z.string().datetime().optional(),
  })
  .strict();
export type CommunicationRequest = z.infer<typeof CommunicationRequestSchema>;

export interface OrderEvidenceDeps {
  findVisibleOrder(orderId: string, sessionId: string): Promise<Order | null>;
  evidence: EvidenceRepo;
  setCompleteness(orderId: string, completeness: number): Promise<void>;
  now?: () => Date;
  log?: (meta: ActivityMeta) => Promise<void>;
}

export async function getOrderEvidence(orderId: string, sessionId: string, deps: OrderEvidenceDeps): Promise<(EvidenceSummaryView & { order: Order }) | null> {
  const order = await deps.findVisibleOrder(orderId, sessionId);
  if (!order) return null;
  return { order, ...summarizeEvidence(await deps.evidence.getEvidenceByOrderId(order.id)) };
}

export type AppendResult =
  | { kind: "appended"; completeness: number }
  | { kind: "not_found" }
  | { kind: "shared_example" }
  | { kind: "not_shipped" }
  | { kind: "invalid"; message: string };

/** Append one buyer communication. Never edits existing evidence; only the order's cached score moves. */
export async function appendCommunication(orderId: string, sessionId: string, input: CommunicationRequest, deps: OrderEvidenceDeps): Promise<AppendResult> {
  const now = (deps.now ?? (() => new Date()))();
  const order = await deps.findVisibleOrder(orderId, sessionId);
  if (!order) return { kind: "not_found" };
  if (order.isSeed) return { kind: "shared_example" };
  if (order.sessionId !== sessionId) return { kind: "not_found" };
  if (order.status !== "shipped") return { kind: "not_shipped" };

  const sentAt = input.sentAt ? new Date(input.sentAt) : now;
  if (sentAt.getTime() > now.getTime() + 60_000) return { kind: "invalid", message: "sentAt cannot be in the future." };

  const started = Date.now();
  await deps.evidence.insertArtefacts([buildCommunicationArtefact(order.id, { ...input, sentAt }, now)]);
  const completeness = computeEvidenceCompleteness(await deps.evidence.getEvidenceByOrderId(order.id));
  await deps.setCompleteness(order.id, completeness);
  try {
    await deps.log?.({
      sessionId,
      refOrderId: order.id,
      stepType: "merchant_action",
      toolName: "log_buyer_communication",
      inputSummary: `${input.direction} message logged`,
      outputSummary: `evidence completeness ${completeness}%`,
      durationMs: Date.now() - started,
      status: "success",
    });
  } catch {
    /* logging is best effort */
  }
  return { kind: "appended", completeness };
}
