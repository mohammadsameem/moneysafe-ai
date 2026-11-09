import { describe, expect, it, vi } from "vitest";
import type { LlmActivityEntry } from "@/lib/ai/call-with-fallback";
import { createActivityLogger, logActivity, toActivityRow, type ActivityMeta } from "../logger";
import { SUMMARY_MAX_CHARS, scrubEmails, summarize } from "../pii";

describe("scrubEmails", () => {
  it("keeps the domain and replaces the local part with ***", () => {
    expect(scrubEmails("jane.doe@example.com")).toBe("***@example.com");
    expect(scrubEmails("buyer: Jane+shop@mail.example.co.uk, paid")).toBe("buyer: ***@mail.example.co.uk, paid");
  });

  it("scrubs every address, including ones next to punctuation", () => {
    expect(scrubEmails("from a@x.io to (b_c@y.org); cc <d-e@z.net>")).toBe("from ***@x.io to (***@y.org); cc <***@z.net>");
  });

  it("handles non-ASCII local parts", () => {
    expect(scrubEmails("josé.müller@beispiel.de")).toBe("***@beispiel.de");
  });

  it("leaves text without an email alone", () => {
    for (const text of ["", "no email here", "price @ 5 each", "user@localhost", "see example.com", "a @ b.com"]) {
      expect(scrubEmails(text)).toBe(text);
    }
  });

  it("is linear on long inputs with no @ (no catastrophic backtracking)", () => {
    const started = Date.now();
    scrubEmails("a".repeat(100_000));
    scrubEmails("a.".repeat(50_000) + "@");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("summarize", () => {
  it("scrubs, collapses whitespace and trims", () => {
    expect(summarize("  order for\n  jane@example.com   shipped\t ")).toBe("order for ***@example.com shipped");
  });

  it("returns an empty string for null and undefined", () => {
    expect(summarize(null)).toBe("");
    expect(summarize(undefined)).toBe("");
  });

  it("caps the length and marks the cut", () => {
    const out = summarize("x ".repeat(1000));
    expect(out.length).toBe(SUMMARY_MAX_CHARS);
    expect(out.endsWith("\u2026")).toBe(true);
  });

  it("scrubs before cutting, so an email at the cut leaves no local part behind", () => {
    const filler = "w".repeat(SUMMARY_MAX_CHARS - 6);
    const out = summarize(`${filler} jane.doe@example.com`);
    expect(out).not.toContain("jane");
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("never lets half an email through when the input is huge", () => {
    // 19,990 characters of filler, then an address that straddles the scan limit.
    const out = summarize(`${"word ".repeat(3998)}jane.doe@example.com tail`, 30_000);
    expect(out).not.toContain("jane.doe@");
  });
});

describe("toActivityRow", () => {
  const meta: ActivityMeta = {
    sessionId: "sid-1",
    refOrderId: "order-1",
    stepType: "paypal_api",
    toolName: "capture_order",
    inputSummary: "buyer jane@example.com",
    outputSummary: "COMPLETED for jane@example.com",
    durationMs: 12.6,
    status: "success",
  };

  it("scrubs both summaries and fills the optional references with null", () => {
    expect(toActivityRow(meta)).toEqual({
      sessionId: "sid-1",
      refOrderId: "order-1",
      refDisputeId: null,
      stepType: "paypal_api",
      toolName: "capture_order",
      inputSummary: "buyer ***@example.com",
      outputSummary: "COMPLETED for ***@example.com",
      durationMs: 13,
      status: "success",
    });
  });

  it("stores a whole, non-negative duration", () => {
    expect(toActivityRow({ ...meta, durationMs: -5 }).durationMs).toBe(0);
    expect(toActivityRow({ ...meta, durationMs: Number.NaN }).durationMs).toBe(0);
    expect(toActivityRow({ ...meta, durationMs: 1.4 }).durationMs).toBe(1);
  });

  it("never stores an empty tool name", () => {
    expect(toActivityRow({ ...meta, toolName: "" }).toolName).toBe("unknown");
    expect(toActivityRow({ ...meta, toolName: undefined as unknown as string }).toolName).toBe("unknown");
    expect(toActivityRow({ ...meta, toolName: "   " }).toolName).toBe("unknown");
  });

  it("caps an over-long tool name", () => {
    expect(toActivityRow({ ...meta, toolName: "t".repeat(300) }).toolName.length).toBe(100);
  });
});

describe("createActivityLogger", () => {
  const meta: ActivityMeta = {
    stepType: "rule_engine",
    toolName: "score_order",
    inputSummary: "in",
    outputSummary: "out",
    durationMs: 1,
    status: "success",
  };

  it("inserts the scrubbed row", async () => {
    const insert = vi.fn(async () => undefined);
    await createActivityLogger(insert)({ ...meta, inputSummary: "x@y.com" });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ inputSummary: "***@y.com", sessionId: null }));
  });

  it("never throws when the write fails, and reports only the error code", async () => {
    const onError = vi.fn();
    const insert = vi.fn(async () => {
      throw Object.assign(new Error('insert failed for jane@example.com password=hunter2'), { code: "23503" });
    });

    await expect(createActivityLogger(insert, onError)(meta)).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("could not write an activity row (code 23503)");
  });

  it("finds the code on the wrapped driver error, as Drizzle throws it", async () => {
    const onError = vi.fn();
    const insert = async () => {
      throw Object.assign(new Error("Failed query: insert into agent_activity ... params: jane@example.com"), {
        cause: Object.assign(new Error("violates foreign key constraint"), { code: "23503" }),
      });
    };

    await createActivityLogger(insert, onError)(meta);

    expect(onError).toHaveBeenCalledWith("could not write an activity row (code 23503)");
  });

  it("reports a failure without a code too", async () => {
    const onError = vi.fn();
    await createActivityLogger(async () => { throw new Error("boom"); }, onError)(meta);
    expect(onError).toHaveBeenCalledWith("could not write an activity row");
  });
});

describe("compatibility with callWithFallback", () => {
  it("the real logger can be passed as LlmDeps.logActivity", () => {
    // Compile-time check: LlmActivityEntry must be assignable to ActivityMeta.
    const asLlmLogger: (entry: LlmActivityEntry) => Promise<void> = logActivity;
    expect(typeof asLlmLogger).toBe("function");
  });
});
