/**
 * A REAL PayPal dispute: who can see it, what is offered, and what is allowed to reach PayPal.
 */
import { describe, expect, it } from "vitest";
import { SEED_C, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import { createFakePayPal } from "@/lib/orders/__tests__/fakes";
import { PayPalError } from "@/lib/paypal";
import { approveDispute, type ApproveDeps } from "../approve";
import { loadDisputeDetail } from "../detail";
import { createLiveGate } from "../live-gate";
import { listDisputeViews } from "../read";
import { DISPUTE_ID, NOW, ORDER_ID, OTHER_SESSION, SESSION, analysed, createFakeDisputesRepo, makeRecord } from "./fakes";

const PP = "PP-R-PIN-10197984";
const GET = `GET /v1/customer/disputes/${PP}`;
const ACCEPT = `POST /v1/customer/disputes/${PP}/accept-claim`;
const EVIDENCE = `POST /v1/customer/disputes/${PP}/provide-evidence`;

/** What the real sandbox returned: inquiry stage, a refund is the only response this app can send. */
const liveDispute = (over: Record<string, unknown> = {}) => ({
  dispute_id: PP,
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_state: "REQUIRED_ACTION",
  dispute_life_cycle_stage: "INQUIRY",
  seller_response_due_date: "2026-11-30T09:43:35.378Z",
  allowed_response_options: { accept_claim: { accept_claim_types: ["PARTIAL_REFUND", "REFUND"] }, make_offer: { offer_types: ["REFUND"] } },
  ...over,
});

const real = (over: Parameters<typeof analysed>[0] = {}) =>
  analysed({ isDemo: false, isSeed: false, paypalDisputeId: PP, sessionId: SESSION, systemRecommendation: "refund", finalRecommendation: "refund", draftResponse: null, winProbability: 0.3, winLikelihoodLabel: "Weak", ...over });

function setup(dispute = real(), paypalResponses: Record<string, unknown | Error> = { [GET]: liveDispute(), [ACCEPT]: {} }, demoMode = false) {
  const repo = createFakeDisputesRepo([makeRecord(dispute)], artefactRows(ORDER_ID, SEED_C));
  const paypal = createFakePayPal(paypalResponses);
  const deps: ApproveDeps = {
    repo,
    executor: { paypal, demoMode, now: () => NOW },
    liveGate: createLiveGate(paypal, demoMode),
    newRequestId: () => "request-id-1",
    now: () => NOW,
  };
  return { repo, paypal, deps, read: { repo, paypal, demoMode, now: () => NOW } };
}
const approve = (deps: ApproveDeps, over: { sessionId?: string; action?: "submit_evidence" | "accept_claim" } = {}) =>
  approveDispute({ disputeId: DISPUTE_ID, sessionId: over.sessionId ?? SESSION, merchantUserId: "m", action: over.action ?? "accept_claim" }, deps);
const posts = (paypal: ReturnType<typeof setup>["paypal"]) => paypal.request.mock.calls.filter((c) => (c[1] as { method: string }).method === "POST");

describe("visibility: a real dispute belongs to the session that owns the matched order", () => {
  it("the owner sees it; another session does not see it in the inbox, on its page, or in the resolved tab", async () => {
    const { read } = setup();
    expect(await listDisputeViews(SESSION, "open", read)).toHaveLength(1);
    expect(await listDisputeViews(OTHER_SESSION, "open", read)).toHaveLength(0);
    expect(await listDisputeViews(OTHER_SESSION, "resolved", read)).toHaveLength(0);
    expect(await loadDisputeDetail(DISPUTE_ID, SESSION, read)).not.toBeNull();
    expect(await loadDisputeDetail(DISPUTE_ID, OTHER_SESSION, read)).toBeNull();
  });

  it("another session cannot approve it: not found, nothing stored, PayPal never contacted", async () => {
    const { deps, repo, paypal } = setup();
    expect(await approve(deps, { sessionId: OTHER_SESSION })).toEqual({ kind: "not_found" });
    expect(repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 0 });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("another session cannot even load the live PayPal status of it", async () => {
    const { read, paypal } = setup();
    await loadDisputeDetail(DISPUTE_ID, OTHER_SESSION, read);
    expect(paypal.request).not.toHaveBeenCalled();
  });
});

describe("the detail page offers only what PayPal allows", () => {
  it("a refund PayPal allows: the normal decision panel, and PayPal's real status is shown", async () => {
    const { read } = setup();
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, read))!;
    expect(detail.panel).toMatchObject({ mode: "decide", action: "accept_claim" });
    expect(detail.live).toMatchObject({ paypalDisputeId: PP, status: "WAITING_FOR_SELLER_RESPONSE", stage: "INQUIRY", reasonCode: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", allowed: ["accept_claim"], readFailed: null });
    expect(detail.willSimulate).toBe(false);
  });

  it("evidence recommended but PayPal does not allow it at this stage: a plain message, no write button", async () => {
    const { read } = setup(real({ systemRecommendation: "contest", finalRecommendation: "contest", draftResponse: "Hello PayPal" }));
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, read))!;
    expect(detail.panel.mode).toBe("blocked");
    expect(detail.panel).toMatchObject({ message: expect.stringContaining("does not currently allow you to submit evidence") });
    expect(detail.panel).toMatchObject({ message: expect.stringContaining("INQUIRY") });
  });

  it("PayPal allows neither action: says so, no write button", async () => {
    const { read } = setup(real(), { [GET]: liveDispute({ allowed_response_options: {} }) });
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, read))!;
    expect(detail.panel).toMatchObject({ mode: "blocked", message: expect.stringContaining("lists no response this app can send") });
  });

  it("PayPal cannot be read: no write button, and the card says why", async () => {
    const { read } = setup(real(), { [GET]: new PayPalError("PayPal is down", 503) });
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, read))!;
    expect(detail.panel.mode).toBe("blocked");
    expect(detail.live?.readFailed).toContain("could not be read");
  });

  it("Demo Mode on: a real dispute cannot be acted on, and PayPal is not contacted", async () => {
    const { read, paypal } = setup(real(), { [GET]: liveDispute() }, true);
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, read))!;
    expect(detail.panel).toMatchObject({ mode: "blocked", message: expect.stringContaining("Demo Mode") });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("a demo dispute has no live card and no PayPal read", async () => {
    const { read, paypal } = setup(real({ isDemo: true, paypalDisputeId: null }));
    const detail = (await loadDisputeDetail(DISPUTE_ID, SESSION, read))!;
    expect(detail.live).toBeNull();
    expect(paypal.request).not.toHaveBeenCalled();
  });
});

describe("approving a real dispute: the existing gate, the LIVE path, never simulated", () => {
  it("sends the refund to PayPal with the stored PayPal-Request-Id, and records it as NOT simulated", async () => {
    const { deps, repo, paypal } = setup();
    const result = await approve(deps);
    expect(result).toMatchObject({ kind: "executed", simulated: false });
    const [post] = posts(paypal);
    expect(post![0]).toBe(`/v1/customer/disputes/${PP}/accept-claim`);
    expect(post![1]).toMatchObject({ method: "POST", requestId: "request-id-1", body: { accept_claim_type: "REFUND" } });
    expect(repo.executions[0]).toMatchObject({ isSimulated: false, paypalRequestId: "request-id-1" });
  });

  it("refuses an action PayPal does not allow BEFORE storing or sending anything (a hand-made request cannot bypass the page)", async () => {
    const { deps, repo, paypal } = setup(real({ systemRecommendation: "contest", finalRecommendation: "contest", draftResponse: "Hello PayPal" }));
    const result = await approve(deps, { action: "submit_evidence" });
    expect(result).toMatchObject({ kind: "live_blocked", message: expect.stringContaining("does not currently allow") });
    expect(repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 0 });
    expect(posts(paypal)).toHaveLength(0);
    expect(paypal.request.mock.calls.some((c) => String(c[0]).endsWith("/provide-evidence"))).toBe(false);
    void EVIDENCE;
  });

  it("Demo Mode on: refused, not simulated, nothing stored", async () => {
    const { deps, repo, paypal } = setup(real(), { [GET]: liveDispute(), [ACCEPT]: {} }, true);
    expect(await approve(deps)).toMatchObject({ kind: "live_blocked", message: expect.stringContaining("Demo Mode") });
    expect(repo.inserts).toEqual({ approvals: 0, executions: 0, rejections: 0 });
    expect(paypal.request).not.toHaveBeenCalled();
  });

  it("PayPal unreadable at approval time: refused, nothing sent", async () => {
    const { deps, repo } = setup(real(), { [GET]: new PayPalError("PayPal is down", 503), [ACCEPT]: {} });
    expect(await approve(deps)).toMatchObject({ kind: "live_blocked", message: expect.stringContaining("could not be read") });
    expect(repo.inserts.executions).toBe(0);
  });

  it("a failed live call is retryable with the SAME request id (no second approval, no second execution)", async () => {
    const { deps, repo, paypal } = setup(real(), { [GET]: liveDispute(), [ACCEPT]: new PayPalError("PayPal 503", 503) });
    const first = await approve(deps);
    expect(first.kind).toBe("execution_failed");
    const second = await approve(deps);
    expect(second.kind).toBe("execution_failed");
    const ids = posts(paypal).map((c) => (c[1] as { requestId: string }).requestId);
    expect(ids).toEqual(["request-id-1", "request-id-1"]);
    expect(repo.inserts).toMatchObject({ approvals: 1, executions: 1 });
  });

  it("once executed, a second approve says so and sends nothing more", async () => {
    const { deps, paypal } = setup();
    await approve(deps);
    expect(await approve(deps)).toMatchObject({ kind: "already_executed" });
    expect(posts(paypal)).toHaveLength(1);
  });
});

describe("createLiveGate", () => {
  it("allows a refund on the exact options the sandbox returned", async () => {
    const gate = createLiveGate(createFakePayPal({ [GET]: liveDispute() }), false);
    expect(await gate(real(), "accept_claim")).toEqual({ ok: true });
  });

  it("allows evidence only when PayPal lists provide_evidence", async () => {
    const gate = createLiveGate(createFakePayPal({ [GET]: liveDispute({ allowed_response_options: { provide_evidence: {} } }) }), false);
    expect(await gate(real(), "submit_evidence")).toEqual({ ok: true });
    expect(await gate(real(), "accept_claim")).toMatchObject({ ok: false });
  });
});
