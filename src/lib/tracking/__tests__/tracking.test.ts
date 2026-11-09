import { describe, expect, it } from "vitest";
import { computeEvidenceCompleteness } from "@/lib/scoring";
import { getTrackingEvents } from "../client";
import { MERCHANT_ORIGIN, mockedEvents, stallsInTransit } from "../mocked";
import { TrackingEventSchema, type TrackingProvider } from "../types";

const HOUR = 3_600_000;
const SHIPPED = new Date("2026-11-01T08:00:00.000Z");
const at = (hours: number) => new Date(SHIPPED.getTime() + hours * HOUR);
const q = (trackingNumber = "9400111899223197428490") => ({ trackingNumber, carrier: "USPS", shippedAt: SHIPPED, destination: "Columbus, OH" });

describe("mocked tracking events", () => {
  it("only contain events between the ship time and now", () => {
    expect(mockedEvents(q(), at(-1))).toEqual([]);
    expect(mockedEvents(q(), at(0)).map((e) => e.status)).toEqual(["Label Created"]);
    expect(mockedEvents(q(), at(30)).map((e) => e.status)).toEqual(["Label Created", "Picked Up", "In Transit"]);
    expect(mockedEvents(q(), at(100)).map((e) => e.status)).toEqual(["Label Created", "Picked Up", "In Transit", "In Transit", "Out for Delivery", "Delivered"]);
  });

  it("are all labelled mocked, valid, in time order, starting at the merchant", () => {
    const events = mockedEvents(q(), at(100));
    for (const e of events) {
      expect(TrackingEventSchema.parse(e)).toEqual(e);
      expect(e.isMocked).toBe(true);
    }
    expect(events.map((e) => e.timestamp)).toEqual([...events.map((e) => e.timestamp)].sort());
    expect(events[0]?.location).toBe(MERCHANT_ORIGIN);
    expect(events.at(-1)?.location).toBe("Columbus, OH");
  });

  it("are deterministic for the same tracking number", () => {
    expect(mockedEvents(q("1Z999"), at(100))).toEqual(mockedEvents(q("1Z999"), at(100)));
  });

  it("a tracking number ending in X stalls In Transit (never delivered)", () => {
    expect(stallsInTransit("ABC123X")).toBe(true);
    expect(stallsInTransit("abc123x ")).toBe(true);
    expect(stallsInTransit("ABC123")).toBe(false);
    const stalled = mockedEvents(q("ABC123X"), at(1000)).map((e) => e.status);
    expect(stalled).not.toContain("Delivered");
    expect(stalled.at(-1)).toBe("In Transit");
  });

  it("feed the completeness score's split tracking criteria", () => {
    const art = (events: unknown) => ({ artefactType: "tracking_events", payload: { events } });
    expect(computeEvidenceCompleteness([art(mockedEvents(q(), at(30)))])).toBe(15); // events present, not delivered
    expect(computeEvidenceCompleteness([art(mockedEvents(q(), at(100)))])).toBe(30); // + Delivered
  });
});

describe("getTrackingEvents", () => {
  const now = () => at(100);
  const realEvents = [{ timestamp: at(1).toISOString(), location: "Real hub", status: "Picked Up" as const, isMocked: false }];

  it("uses the mocked provider when none is configured, and says why", async () => {
    const out = await getTrackingEvents(q(), { now });
    expect(out.fallback).toBe("no_provider");
    expect(out.result).toMatchObject({ provider: "mocked", isMocked: true });
    expect(out.result.events.every((e) => e.isMocked)).toBe(true);
  });

  it("uses the mocked provider in DEMO_MODE without calling a real one", async () => {
    let called = false;
    const provider: TrackingProvider = { name: "real", getEvents: async () => { called = true; return realEvents; } };
    const out = await getTrackingEvents(q(), { provider, demoMode: true, now });
    expect(out.fallback).toBe("demo_mode");
    expect(called).toBe(false);
  });

  it("returns a real provider's validated events, not labelled mocked", async () => {
    const provider: TrackingProvider = { name: "real", getEvents: async () => realEvents };
    const out = await getTrackingEvents(q(), { provider, now });
    expect(out.fallback).toBeUndefined();
    expect(out.result).toEqual({ provider: "real", isMocked: false, events: realEvents });
  });

  it("falls back to mocked events, never throwing, when the provider fails or answers nonsense", async () => {
    const failing: TrackingProvider = { name: "real", getEvents: async () => { throw new Error("rate limited"); } };
    expect((await getTrackingEvents(q(), { provider: failing, now })).fallback).toBe("provider_error");
    const nonsense = { name: "real", getEvents: async () => [{ status: "Teleported", timestamp: "yesterday" }] } as unknown as TrackingProvider;
    const out = await getTrackingEvents(q(), { provider: nonsense, now });
    expect(out.fallback).toBe("invalid_response");
    expect(out.result.isMocked).toBe(true);
  });
});
