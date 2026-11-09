import { describe, expect, it } from "vitest";
import { formatDate, formatUsd, riskBadgeText, riskLevel, shortId, signalLabel, sortOrders } from "../format";
import { SIGNAL_NAMES } from "../scoring";

describe("risk presentation", () => {
  it("maps verdicts to levels and labels", () => {
    expect(riskLevel("ship")).toBe("low");
    expect(riskLevel("verify")).toBe("medium");
    expect(riskLevel("hold")).toBe("high");
    expect(riskLevel(null)).toBe("none");
    expect(riskBadgeText("verify", 55)).toBe("Verify first · 55");
    expect(riskBadgeText("ship", 0)).toBe("Ship · 0");
    expect(riskBadgeText(null, null)).toBe("Not scored");
    expect(riskBadgeText("ship", null)).toBe("Not scored");
  });

  it("has a readable label for every signal the engine can fire", () => {
    for (const name of SIGNAL_NAMES) expect(signalLabel(name)).not.toBe(name);
    expect(signalLabel("some_new_signal")).toBe("some new signal");
  });
});

describe("formatting", () => {
  it("formats money and falls back for an unknown currency", () => {
    expect(formatUsd(210)).toBe("$210.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(5, "NOPE1")).toBe("5.00 NOPE1");
  });

  it("formats dates in UTC so server and browser agree", () => {
    expect(formatDate("2026-11-08T23:59:59.000Z")).toBe("Nov 8, 2026");
    expect(formatDate("2026-11-09T00:00:00.000Z")).toBe("Nov 9, 2026");
    expect(formatDate("garbage")).toBe("garbage");
  });

  it("shortens ids", () => {
    expect(shortId("22222222-2222-4222-8222-222222222222")).toBe("22222222");
  });
});

describe("sortOrders", () => {
  const row = (id: string, over: Partial<Parameters<typeof sortOrders>[0][number]> = {}) => ({
    id,
    buyerEmail: "b@x.com",
    amountUsd: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    riskScore: 0 as number | null,
    ...over,
  });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("sorts by risk, with unscored orders last in both directions", () => {
    const rows = [row("a", { riskScore: 40 }), row("b", { riskScore: null }), row("c", { riskScore: 70 }), row("d", { riskScore: 0 })];
    expect(ids(sortOrders(rows, "risk", "desc"))).toEqual(["c", "a", "d", "b"]);
    expect(ids(sortOrders(rows, "risk", "asc"))).toEqual(["d", "a", "c", "b"]);
  });

  it("sorts by amount, date and buyer (case-insensitively)", () => {
    const rows = [
      row("a", { amountUsd: 50, createdAt: "2026-03-01T00:00:00.000Z", buyerEmail: "Zed@x.com" }),
      row("b", { amountUsd: 5, createdAt: "2026-01-01T00:00:00.000Z", buyerEmail: "amy@x.com" }),
      row("c", { amountUsd: 500, createdAt: "2026-02-01T00:00:00.000Z", buyerEmail: "Bob@x.com" }),
    ];
    expect(ids(sortOrders(rows, "amount", "desc"))).toEqual(["c", "a", "b"]);
    expect(ids(sortOrders(rows, "date", "asc"))).toEqual(["b", "c", "a"]);
    expect(ids(sortOrders(rows, "buyer", "asc"))).toEqual(["b", "c", "a"]);
  });

  it("breaks ties by id and never changes its input", () => {
    const rows = [row("b"), row("a"), row("c")];
    const copy = [...rows];
    expect(ids(sortOrders(rows, "amount", "asc"))).toEqual(["a", "b", "c"]);
    expect(rows).toEqual(copy);
  });
});
