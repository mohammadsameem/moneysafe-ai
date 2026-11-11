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
    /** PayPal's per-problem detail (issue code, field name, description), already trimmed. No values, tokens or payloads. */
    readonly issues: PayPalIssue[] = [],
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export interface PayPalIssue {
  issue?: string;
  field?: string;
  description?: string;
}

/** "ISSUE (field: description)" for each problem, compact enough for a one-line summary. */
export function describeIssues(issues: readonly PayPalIssue[]): string {
  return issues
    .map((i) => `${i.issue ?? "ISSUE"}${i.field || i.description ? ` (${[i.field && `field ${i.field}`, i.description].filter(Boolean).join(": ")})` : ""}`)
    .join("; ");
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
