/**
 * PII scrubbing for agent_activity summaries (REQ-AA-01).
 *
 * The one rule: an email address keeps its domain and loses its local part ("jane.doe@x.com"
 * becomes "***@x.com"). The domain stays because it is useful for debugging (disposable-mail
 * signals) and identifies no person.
 */

/** Longest text the scrubber will look at. Bounds memory; the regex itself is linear. */
const SCAN_LIMIT = 20_000;
/** Longest summary stored in agent_activity. */
export const SUMMARY_MAX_CHARS = 500;

const LOCAL_CHAR = "[\\p{L}\\p{N}._%+'-]";
// The lookbehind makes a match start only at the beginning of a run of local-part characters, so a
// long run with no "@" is scanned once instead of once per character.
const EMAIL = new RegExp(`(?<!${LOCAL_CHAR})${LOCAL_CHAR}+@([\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+)`, "gu");

/** Replace the local part of every email address in `text` with `***`. */
export function scrubEmails(text: string): string {
  return text.replace(EMAIL, "***@$1");
}

/**
 * Limit how much text is scanned without ever cutting a word in half: half an email address
 * would not be recognised and its local part would survive.
 */
function boundedInput(text: string): string {
  if (text.length <= SCAN_LIMIT) return text;
  const cut = text.slice(0, SCAN_LIMIT);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf("\t"), cut.lastIndexOf("\r"));
  return lastBreak > 0 ? cut.slice(0, lastBreak) : "";
}

/**
 * Make `text` safe to store as an activity summary: scrub emails, collapse whitespace, and cap
 * the length. Scrubbing happens BEFORE the final cut, so the cut can never leave half an email.
 */
export function summarize(text: string | null | undefined, maxChars: number = SUMMARY_MAX_CHARS): string {
  const scrubbed = scrubEmails(boundedInput(String(text ?? ""))).replace(/\s+/g, " ").trim();
  return scrubbed.length <= maxChars ? scrubbed : `${scrubbed.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}
