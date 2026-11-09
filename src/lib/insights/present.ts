/** Display helpers for the Insights page. Pure, so they are unit-tested without a browser. */
import type { Tone } from "@/lib/disputes/present";

export type DeltaDirection = "up" | "down" | "none";

export interface DeltaView {
  direction: DeltaDirection;
  arrow: string;
  /** "+3", "\u22123" or "No change". */
  text: string;
  /** For screen readers: the colour is never the only signal. */
  spoken: string;
  /** Tailwind text colour. */
  className: string;
}

const MINUS = "\u2212";

/** A weight that went up counts more toward a risk score (amber); one that went down counts less (blue). */
export function describeDelta(delta: number, against = "the starting value"): DeltaView {
  if (delta > 0) return { direction: "up", arrow: "\u2191", text: `+${delta}`, spoken: `up ${delta} from ${against}`, className: "text-amber-800" };
  if (delta < 0) return { direction: "down", arrow: "\u2193", text: `${MINUS}${Math.abs(delta)}`, spoken: `down ${Math.abs(delta)} from ${against}`, className: "text-sky-800" };
  return { direction: "none", arrow: "\u2013", text: "No change", spoken: `no change from ${against}`, className: "text-muted-foreground" };
}

export interface OutcomeBar {
  key: "won" | "lost" | "refunded";
  label: string;
  count: number;
  /** Bar length as a whole percent of the largest count (0 when there are no outcomes). */
  widthPercent: number;
  tone: Tone;
}

/** The bars of the outcome breakdown, in a fixed order, scaled to the largest count. */
export function outcomeBars(outcomes: { won: number; lost: number; refunded: number }): OutcomeBar[] {
  const largest = Math.max(outcomes.won, outcomes.lost, outcomes.refunded, 0);
  const bar = (key: OutcomeBar["key"], label: string, count: number, tone: Tone): OutcomeBar => ({
    key,
    label,
    count,
    widthPercent: largest === 0 ? 0 : Math.round((count / largest) * 100),
    tone,
  });
  return [bar("won", "Won", outcomes.won, "good"), bar("lost", "Lost", outcomes.lost, "bad"), bar("refunded", "Refunded", outcomes.refunded, "warn")];
}

/** "3 more resolved disputes until a new proposal is considered" / "A proposal is waiting for your decision". */
export function progressText(progress: { remaining: number; every: number; proposalPending: boolean; resolved: number }): string {
  if (progress.proposalPending) {
    return `A weight proposal is waiting for your decision. No new one is requested until you approve or reject it; resolved disputes keep being counted (${progress.resolved} so far).`;
  }
  const n = progress.remaining;
  return `A new proposal is considered after every ${progress.every} resolved disputes: ${n} more to go.`;
}
