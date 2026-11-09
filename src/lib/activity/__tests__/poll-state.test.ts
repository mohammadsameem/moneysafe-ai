import { describe, expect, it } from "vitest";
import { FAILURES_BEFORE_ERROR, FEED_STATUS_TEXT, INITIAL_HEALTH, PollHttpError, afterFailure, afterSuccess, feedState, nextDelayMs, type Health } from "../poll-state";

const fail = (h: Health, e: unknown = new PollHttpError(500)) => afterFailure(h, e);

describe("feed state", () => {
  it("starts ok and says so", () => {
    expect(feedState(INITIAL_HEALTH)).toBe("ok");
    expect(FEED_STATUS_TEXT.ok).toBe("Updates every 5 seconds");
  });

  it("one failed poll is a quiet retry, not an error message", () => {
    const h = fail(INITIAL_HEALTH);
    expect(feedState(h)).toBe("retrying");
    expect(FEED_STATUS_TEXT.retrying).not.toMatch(/could not/i);
  });

  it("the next success clears it completely", () => {
    expect(feedState(afterSuccess())).toBe("ok");
    expect(feedState(afterSuccess())).toBe("ok");
  });

  it("an error message appears only after repeated failures", () => {
    let h = INITIAL_HEALTH;
    const seen: string[] = [];
    for (let i = 0; i < FAILURES_BEFORE_ERROR; i++) {
      h = fail(h);
      seen.push(feedState(h));
    }
    expect(seen).toEqual(["retrying", "retrying", "error"]);
  });

  it("network errors and timeouts count like server errors", () => {
    expect(feedState(fail(INITIAL_HEALTH, new TypeError("Failed to fetch")))).toBe("retrying");
    expect(feedState(fail(INITIAL_HEALTH, new DOMException("aborted", "AbortError")))).toBe("retrying");
  });

  it("a 401 ends the session state at once, whatever came before", () => {
    expect(feedState(fail(INITIAL_HEALTH, new PollHttpError(401)))).toBe("session-ended");
    expect(feedState(fail(fail(INITIAL_HEALTH), new PollHttpError(401)))).toBe("session-ended");
  });

  it("other 4xx and 5xx answers are retried, not treated as the end of the session", () => {
    for (const status of [400, 403, 404, 429, 500, 502, 503]) expect(feedState(fail(INITIAL_HEALTH, new PollHttpError(status)))).toBe("retrying");
  });
});

describe("next poll delay", () => {
  it("is the normal interval while healthy and during the first failures", () => {
    expect(nextDelayMs(5000, INITIAL_HEALTH)).toBe(5000);
    expect(nextDelayMs(5000, { failures: 1, sessionEnded: false })).toBe(5000);
    expect(nextDelayMs(5000, { failures: FAILURES_BEFORE_ERROR - 1, sessionEnded: false })).toBe(5000);
  });

  it("backs off to 2x, then 4x, and never beyond", () => {
    const delays = [3, 4, 5, 6, 20].map((failures) => nextDelayMs(5000, { failures, sessionEnded: false }));
    expect(delays).toEqual([10_000, 20_000, 20_000, 20_000, 20_000]);
  });
});
