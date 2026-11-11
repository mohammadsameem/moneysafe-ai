/**
 * The decision panel for a REAL PayPal dispute: what it shows, and (just as important) what it does not offer.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PanelState } from "@/lib/disputes/detail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined }) }));
vi.mock("@/components/toast/toast-provider", () => ({ useToast: () => ({ toast: () => undefined }) }));

import { ApprovalPanel } from "@/components/disputes/approval-panel";

const render = (panel: PanelState, extra: { lastWriteError?: string | null } = {}) =>
  renderToStaticMarkup(createElement(ApprovalPanel, { disputeId: "d-1", panel, amountUsd: 230, willSimulate: false, ...extra }));

const noWriteControls = (html: string) => {
  expect(html).not.toMatch(/>\s*(Approve|Approve refund|Approve edited response|Reject|Retry|Yes, send it)\s*</);
  expect(html).not.toContain("<textarea");
};

describe("ApprovalPanel on a real PayPal dispute", () => {
  it("closed on PayPal: says 'Resolved on PayPal' and offers no Approve, Reject or Retry", () => {
    const html = render({ mode: "resolved_on_paypal", message: "PayPal closed this dispute in the buyer's favour (seller issued refund). The buyer was refunded." });
    expect(html).toContain("Resolved on PayPal");
    expect(html).toContain("buyer&#x27;s favour");
    expect(html).toContain("not decided here");
    noWriteControls(html);
  });

  it("blocked (PayPal does not allow it): explains why and offers no write button", () => {
    const html = render({ mode: "blocked", action: "submit_evidence", message: "PayPal does not currently allow you to submit evidence on this dispute (status X, stage INQUIRY)." });
    expect(html).toContain("Nothing can be sent to PayPal right now");
    expect(html).toContain("stage INQUIRY");
    noWriteControls(html);
  });

  it("retry after a failed live write: shows PayPal's error (issue codes, field, debug_id) from the log, with a Retry button", () => {
    const html = render({ mode: "retry", action: "accept_claim", approvedAt: "2026-11-10T10:12:23.282Z" }, { lastWriteError: "HTTP 422 | issues: MISSING_REQUIRED_PARAMETER (field /accept_claim_reason) | debug_id f56878855ceca" });
    expect(html).toContain("PayPal said:");
    expect(html).toContain("MISSING_REQUIRED_PARAMETER");
    expect(html).toContain("debug_id f56878855ceca");
    expect(html).toMatch(/>\s*Retry\s*</);
  });

  it("no stored error: shows no 'PayPal said' line", () => {
    expect(render({ mode: "retry", action: "accept_claim", approvedAt: "2026-11-10T10:12:23.282Z" })).not.toContain("PayPal said:");
  });

  it("an ordinary decision still shows Approve and Reject (nothing else was broken)", () => {
    const html = render({ mode: "decide", action: "accept_claim", draft: null, rejectedAt: null });
    expect(html).toContain("Approve refund");
    expect(html).toMatch(/>\s*Reject\s*</);
  });
});
