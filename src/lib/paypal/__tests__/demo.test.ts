import { describe, expect, it, vi } from "vitest";
import { shouldSimulateWrite, withDemoFallback } from "../demo";
import { PayPalError } from "../errors";

const SEED = { id: "SEED" };
const LIVE = { id: "LIVE" };

describe("withDemoFallback (reads)", () => {
  it("returns the live response, not flagged as demo, when PayPal works", async () => {
    const seed = vi.fn(() => SEED);
    const out = await withDemoFallback(async () => LIVE, seed, { demoMode: false });
    expect(out).toEqual({ data: LIVE, isDemo: false });
    expect(seed).not.toHaveBeenCalled();
  });

  it("DEMO_MODE=true returns seeded data and never makes the live call", async () => {
    const live = vi.fn(async () => LIVE);
    const onFallback = vi.fn();
    const out = await withDemoFallback(live, () => SEED, { demoMode: true, onFallback });
    expect(out).toEqual({ data: SEED, isDemo: true, reason: "demo_mode" });
    expect(live).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledWith({ reason: "demo_mode", message: undefined });
  });

  it("no PayPal credentials (live call is null) returns seeded data", async () => {
    const out = await withDemoFallback(null, () => SEED, { demoMode: false });
    expect(out).toEqual({ data: SEED, isDemo: true, reason: "no_credentials" });
  });

  it("a PayPal error falls back to seeded data and reports why (without crashing)", async () => {
    const onFallback = vi.fn();
    const out = await withDemoFallback(
      async () => {
        throw new PayPalError("PayPal GET /v1/customer/disputes failed with HTTP 503", 503);
      },
      () => SEED,
      { demoMode: false, onFallback },
    );
    expect(out).toEqual({ data: SEED, isDemo: true, reason: "paypal_error" });
    expect(onFallback).toHaveBeenCalledWith({ reason: "paypal_error", message: expect.stringContaining("HTTP 503") });
  });

  it("an unexpected (non-PayPal) error is rethrown: a bug must not be disguised as demo data", async () => {
    await expect(
      withDemoFallback(
        async () => {
          throw new TypeError("cannot read properties of undefined");
        },
        () => SEED,
        { demoMode: false },
      ),
    ).rejects.toThrow(TypeError);
  });

  it("a failing fallback logger never changes the outcome", async () => {
    const out = await withDemoFallback(null, () => SEED, {
      demoMode: false,
      onFallback: () => {
        throw new Error("log write failed");
      },
    });
    expect(out.isDemo).toBe(true);
  });
});

describe("shouldSimulateWrite", () => {
  it("simulates when DEMO_MODE is on, or the dispute is a seed or demo dispute", () => {
    expect(shouldSimulateWrite({ isSeed: false, isDemo: false }, true)).toBe(true);
    expect(shouldSimulateWrite({ isSeed: true, isDemo: false }, false)).toBe(true);
    expect(shouldSimulateWrite({ isSeed: false, isDemo: true }, false)).toBe(true);
  });

  it("does NOT simulate a real dispute: a live write failure must surface and allow retry", () => {
    expect(shouldSimulateWrite({ isSeed: false, isDemo: false }, false)).toBe(false);
    expect(shouldSimulateWrite({}, false)).toBe(false);
  });
});
