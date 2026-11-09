/**
 * Error types for the PayPal service layer.
 * None of them carry credentials, access tokens or request payloads.
 */

/** PayPal returned an error, or could not be reached. */
export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** PayPal's `debug_id` from the error body, handy when talking to PayPal support. */
    readonly debugId?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

/**
 * A money-moving PayPal call was attempted without a valid, matching, approved approval record.
 * Thrown BEFORE any network call is made (REQ-NFR-03).
 */
export class ApprovalRequiredError extends Error {
  constructor(
    readonly reason:
      | "missing_id"
      | "not_found"
      | "not_approved"
      | "dispute_mismatch"
      | "action_mismatch",
  ) {
    super(`PayPal write blocked: approval required (${reason})`);
    this.name = "ApprovalRequiredError";
  }
}
