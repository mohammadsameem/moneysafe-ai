/** What an error card says. Pure, so it is unit-tested without a browser. */

export interface ErrorView {
  title: string;
  message: string;
  /** Next's error digest, so a failure in the server log can be matched to what the person saw. */
  reference: string | null;
}

/**
 * The text shown when a page or section fails to render. It never repeats the error's own message:
 * in production Next hides server messages anyway, and a message can carry details a visitor should
 * not see. The reassurance is true by construction: rendering reads data, it does not send anything.
 */
export function describeError(error: { digest?: string | undefined }, what = "this page"): ErrorView {
  return {
    title: "Something went wrong",
    message: `We could not show ${what}. Nothing was changed and nothing was sent to PayPal. Try again; if it keeps happening, reload the page.`,
    reference: error.digest ? String(error.digest).slice(0, 24) : null,
  };
}

/** The sentence shown while a section is loading, for screen readers. */
export const loadingLabel = (what: string): string => `Loading ${what}…`;
