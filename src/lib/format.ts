/** Small display helpers shared by the UI. Pure, so they are unit-tested without a browser. */
import type { Verdict } from "@/lib/scoring";

export type RiskLevel = "low" | "medium" | "high" | "none";

export const VERDICT_LABEL: Record<Verdict, string> = { ship: "Ship", verify: "Verify first", hold: "Hold" };
const LEVEL_BY_VERDICT: Record<Verdict, Exclude<RiskLevel, "none">> = { ship: "low", verify: "medium", hold: "high" };
export const LEVEL_LABEL: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High", none: "Not scored" };

export function riskLevel(verdict: Verdict | null | undefined): RiskLevel {
  return verdict ? LEVEL_BY_VERDICT[verdict] : "none";
}

/** Label shown on a risk badge, e.g. "Verify first · 55". Colour is never the only signal. */
export function riskBadgeText(verdict: Verdict | null | undefined, score: number | null | undefined): string {
  if (!verdict || score === null || score === undefined) return LEVEL_LABEL.none;
  return `${VERDICT_LABEL[verdict]} \u00b7 ${score}`;
}

export function formatUsd(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`; // an unknown currency code
  }
}

/** "Nov 8, 2026" in UTC, so server and browser render the same text. Unparseable input is returned as is. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

/** First 8 characters of an id, for tables. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The note shown wherever a rule-based result stands in for an AI one. */
export const AI_UNAVAILABLE_NOTE = "AI unavailable \u2014 showing rule-based result.";

export const SIGNAL_LABEL: Record<string, string> = {
  country_mismatch: "Billing and shipping countries differ",
  first_time_high_value: "First-time buyer, high value",
  rush_shipping: "Rush or overnight shipping",
  high_relative_value: "Much larger than your usual order",
  disposable_email: "Disposable email address",
  repeated_attempts: "Repeated payment attempts",
};

export function signalLabel(signal: string): string {
  return SIGNAL_LABEL[signal] ?? signal.replace(/_/g, " ");
}

export type SortKey = "id" | "buyer" | "amount" | "date" | "risk";
export type SortDirection = "asc" | "desc";

interface Sortable {
  id: string;
  buyerEmail: string;
  amountUsd: number;
  createdAt: string;
  riskScore: number | null;
}

/** Sort a copy of `rows`. Unscored orders always sort last, whichever direction is chosen. */
export function sortOrders<T extends Sortable>(rows: readonly T[], key: SortKey, direction: SortDirection): T[] {
  const sign = direction === "asc" ? 1 : -1;
  const value = (r: T): string | number | null => {
    switch (key) {
      case "id":
        return r.id;
      case "buyer":
        return r.buyerEmail.toLowerCase();
      case "amount":
        return r.amountUsd;
      case "date":
        return r.createdAt;
      case "risk":
        return r.riskScore;
    }
  };
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -sign : x > y ? sign : a.id < b.id ? -1 : 1; // ties: stable by id
  });
}
