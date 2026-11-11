/**
 * Pure helpers for REAL PayPal disputes: how a PayPal reason maps onto the two reasons this app models, how the real
 * reason is carried with the dispute (in the buyer-message text, which already goes to the analysis as untrusted data),
 * and which actions PayPal currently allows.
 */
import type { Dispute } from "@/db/schema";
import type { DisputeActionType } from "./types";

type DisputeReason = Dispute["reason"];

const REASON_LABEL: Record<DisputeReason, string> = { item_not_received: "item not received", not_as_described: "not as described" };

/** PayPal reason codes that mean exactly one of the two reasons the app models. */
const EXACT: Record<string, DisputeReason> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "item_not_received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not_as_described",
  SIGNIFICANTLY_NOT_AS_DESCRIBED: "not_as_described",
};

/**
 * The app's reason for a PayPal reason code. A code the app does not model is mapped to "item not received" (the closest
 * general "the buyer did not get what they paid for" case) and flagged `exact: false`, so the analysis says so.
 */
export function mapPayPalReason(code: string | undefined | null): { reason: DisputeReason; exact: boolean } {
  const hit = code ? EXACT[code] : undefined;
  return hit ? { reason: hit, exact: true } : { reason: "item_not_received", exact: false };
}

/** The text stored as the dispute's buyer message: PayPal's real reason first, then what the buyer wrote. */
export function formatIngestedBuyerMessage(code: string | undefined | null, buyerText: string | null): string {
  const { reason, exact } = mapPayPalReason(code);
  const lines = [`PayPal reason: ${code ?? "(not given)"}`];
  if (!exact) lines.push(`This app has no exact category for that reason and analyses it as "${REASON_LABEL[reason]}", the closest it supports.`);
  if (buyerText && buyerText.trim()) lines.push(`Buyer wrote: ${buyerText.trim().slice(0, 500)}`);
  return lines.join("\n");
}

/** One sentence for the analysis when the dispute came from PayPal (null for every other dispute). */
export function paypalReasonNote(buyerMessage: string | null): string | null {
  const match = /^PayPal reason: (\S+)/.exec(buyerMessage ?? "");
  if (!match) return null;
  const mapped = /analyses it as "([^"]+)"/.exec(buyerMessage ?? "");
  return mapped
    ? `PayPal reports this dispute with the reason ${match[1]}. The app does not model that reason exactly, so it is analysed as "${mapped[1]}", the closest supported reason.`
    : `PayPal reports this dispute with the reason ${match[1]}.`;
}

/**
 * The actions this app can send that PayPal lists in `allowed_response_options`. Fails closed: anything unrecognised
 * is NOT allowed.
 *   accept_claim   allowed when the object has `accept_claim` offering the REFUND type (the only type the app sends)
 *   submit_evidence allowed when the object has `provide_evidence`
 */
export function allowedActions(options: unknown): DisputeActionType[] {
  if (!options || typeof options !== "object" || Array.isArray(options)) return [];
  const o = options as Record<string, unknown>;
  const actions: DisputeActionType[] = [];
  if (o.provide_evidence !== undefined && o.provide_evidence !== null) actions.push("submit_evidence");
  const accept = o.accept_claim;
  if (accept && typeof accept === "object") {
    const types = (accept as Record<string, unknown>).accept_claim_types;
    if (Array.isArray(types) && types.includes("REFUND")) actions.push("accept_claim");
  }
  return actions;
}

/** What PayPal says about a real dispute right now (read fresh on every page view). */
export interface LiveDisputeInfo {
  paypalDisputeId: string;
  reasonCode: string | null;
  status: string | null;
  state: string | null;
  stage: string | null;
  /** ISO. When PayPal wants the seller's response. */
  dueDate: string | null;
  /** The actions this app can send that PayPal allows right now. */
  allowed: DisputeActionType[];
  /** Set when PayPal could not be read or must not be contacted: no write is offered then. */
  readFailed: string | null;
  /** PayPal's `dispute_outcome` once the dispute is closed there (e.g. RESOLVED_BUYER_FAVOUR / SELLER_ISSUED_REFUND). */
  outcomeCode?: string | null;
  outcomeReason?: string | null;
}

const ACTION_LABEL: Record<DisputeActionType, string> = { submit_evidence: "submit evidence", accept_claim: "accept the claim (refund)" };
export const actionLabel = (a: DisputeActionType): string => ACTION_LABEL[a];

/** Why no write button is offered for `action` on this real dispute, or null when PayPal allows it. */
export function liveBlockReason(live: LiveDisputeInfo, action: DisputeActionType): string | null {
  if (live.readFailed) return `${live.readFailed} No action is offered until PayPal can be read.`;
  if (live.allowed.includes(action)) return null;
  const where = [live.status && `status ${live.status}`, live.stage && `stage ${live.stage}`].filter(Boolean).join(", ");
  const others = live.allowed.map(actionLabel);
  return `PayPal does not currently allow you to ${actionLabel(action)} on this dispute${where ? ` (${where})` : ""}. ${
    others.length ? `It allows: ${others.join(", ")}, which is not what the analysis recommends.` : "It lists no response this app can send."
  } No action is offered here.`;
}

/** True for a dispute that came from PayPal and belongs to a real order: the only kind that is ever sent to PayPal live. */
export const isRealDispute = (d: Pick<Dispute, "isSeed" | "isDemo" | "paypalDisputeId">): boolean => !d.isSeed && !d.isDemo && Boolean(d.paypalDisputeId);
