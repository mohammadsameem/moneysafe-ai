/**
 * Messages the PayPal return/cancel handlers pass to the Orders page as `?notice=<key>`.
 * The key is in the URL; the text lives here, so a crafted link can only select one of these.
 */
export const ORDER_NOTICES = {
  order_not_found: "We could not find that order in your session.",
  order_cancelled: "The PayPal payment was cancelled. No order was placed.",
  capture_failed: "PayPal did not complete the payment, so the order was not captured.",
  scoring_failed: "The payment was captured, but the risk score could not be computed yet.",
} as const;

export type OrderNoticeKey = keyof typeof ORDER_NOTICES;

export function isOrderNoticeKey(value: string | null | undefined): value is OrderNoticeKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ORDER_NOTICES, value);
}
