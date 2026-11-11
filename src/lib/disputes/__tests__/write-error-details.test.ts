/**
 * A failed LIVE write keeps PayPal's own words: the issue codes, the field names and the debug_id. They appear in the
 * approve result, in the activity row, and (read back from the log) on the page after a reload. No secret ever does.
 */
import { describe, expect, it } from "vitest";
import { SEED_C, artefactRows } from "@/lib/evidence/__tests__/fixtures";
import { createFakePayPal } from "@/lib/orders/__tests__/fakes";
import { PayPalError } from "@/lib/paypal";
import { approveDispute } from "../approve";
import { createLiveGate } from "../live-gate";
import { toActivityRow } from "@/lib/activity/logger";
import { DISPUTE_ID, NOW, ORDER_ID, SESSION, analysed, createFakeDisputesRepo, makeRecord } from "./fakes";

const PP = "PP-R-PIN-10197984";
const GET = `GET /v1/customer/disputes/${PP}`;
const ACCEPT = `POST /v1/customer/disputes/${PP}/accept-claim`;
const open = { dispute_id: PP, status: "WAITING_FOR_SELLER_RESPONSE", allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] } } };

const error422 = new PayPalError(
  "PayPal POST /v1/customer/disputes/PP-R-PIN-10197984/accept-claim failed with HTTP 422 (UNPROCESSABLE_ENTITY: The requested action could not be performed. | issues: MISSING_REQUIRED_PARAMETER (field /accept_claim_reason: A required field is missing.) | debug_id f56878855ceca)",
  422,
  "f56878855ceca",
  [{ issue: "MISSING_REQUIRED_PARAMETER", field: "/accept_claim_reason", description: "A required field is missing." }],
);

function setup() {
  const repo = createFakeDisputesRepo(
    [makeRecord(analysed({ isDemo: false, isSeed: false, paypalDisputeId: PP, sessionId: SESSION, systemRecommendation: "refund", finalRecommendation: "refund", draftResponse: null }))],
    artefactRows(ORDER_ID, SEED_C),
  );
  const paypal = createFakePayPal({ [GET]: open, [ACCEPT]: error422 });
  const logs: Array<Parameters<typeof toActivityRow>[0]> = [];
  const deps = { repo, executor: { paypal, demoMode: false, now: () => NOW, log: async (m: Parameters<typeof toActivityRow>[0]) => void logs.push(m) }, liveGate: createLiveGate(paypal, false), newRequestId: () => "req-1", now: () => NOW };
  return { repo, paypal, deps, logs };
}

describe("a failed live write", () => {
  it("returns PayPal's issue codes, field names and debug_id", async () => {
    const { deps } = setup();
    const result = await approveDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" }, deps);
    expect(result).toMatchObject({
      kind: "execution_failed",
      error: { httpStatus: 422, debugId: "f56878855ceca", issues: [{ issue: "MISSING_REQUIRED_PARAMETER", field: "/accept_claim_reason", description: "A required field is missing." }] },
    });
    expect(result.kind === "execution_failed" && result.message).toContain("debug_id f56878855ceca");
  });

  it("writes them to the activity row (as an error), within the row's length cap, without a secret", async () => {
    const { deps, logs } = setup();
    await approveDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" }, deps);
    const failure = logs.find((l) => l.toolName === "accept_claim" && l.status === "error");
    expect(failure).toBeDefined();
    const row = toActivityRow(failure!);
    for (const part of ["HTTP 422", "MISSING_REQUIRED_PARAMETER", "/accept_claim_reason", "debug_id f56878855ceca"]) expect(row.outputSummary).toContain(part);
    expect(row.outputSummary.length).toBeLessThanOrEqual(500);
    expect(row.outputSummary).not.toMatch(/Bearer|access_token|client_secret/i);
  });

  it("is retryable with the same request id, and each attempt keeps its own error", async () => {
    const { deps, repo, paypal, logs } = setup();
    const req = { disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" as const };
    await approveDispute(req, deps);
    await approveDispute(req, deps);
    const ids = paypal.request.mock.calls.filter((c) => (c[1] as { method: string }).method === "POST").map((c) => (c[1] as { requestId: string }).requestId);
    expect(ids).toEqual(["req-1", "req-1"]);
    expect(repo.inserts).toMatchObject({ approvals: 1, executions: 1 });
    expect(logs.filter((l) => l.status === "error")).toHaveLength(2);
  });

  it("the route-visible error has no values from the request (the stored note is not echoed)", async () => {
    const { deps } = setup();
    const result = await approveDispute({ disputeId: DISPUTE_ID, sessionId: SESSION, merchantUserId: "m", action: "accept_claim" }, deps);
    expect(JSON.stringify(result.kind === "execution_failed" ? result.error : {})).not.toContain("The merchant accepts the claim");
  });
});
