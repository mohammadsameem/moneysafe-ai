import type { Verdict } from "@/lib/scoring";
import { LEVEL_LABEL, riskBadgeText, riskLevel, type RiskLevel } from "@/lib/format";

const base = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium";

const LEVEL_STYLE: Record<RiskLevel, { badge: string; dot: string }> = {
  low: { badge: "border-green-300 bg-green-50 text-green-900", dot: "bg-green-600" },
  medium: { badge: "border-amber-300 bg-amber-50 text-amber-900", dot: "bg-amber-500" },
  high: { badge: "border-red-300 bg-red-50 text-red-900", dot: "bg-red-600" },
  none: { badge: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
};

/** Colour-coded risk badge. The text carries the meaning, so it also works without colour. */
export function RiskBadge({ verdict, score }: { verdict: Verdict | null; score: number | null }) {
  const level = riskLevel(verdict);
  const style = LEVEL_STYLE[level];
  return (
    <span className={`${base} ${style.badge}`} title={`${LEVEL_LABEL[level]} risk`}>
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${style.dot}`} />
      {riskBadgeText(verdict, score)}
      {level !== "none" ? <span className="sr-only">{`, ${LEVEL_LABEL[level].toLowerCase()} risk`}</span> : null}
    </span>
  );
}

/** Shown on every seeded or demo record (REQ-DEMO-07). */
export function DemoBadge() {
  return (
    <span className={`${base} border-violet-300 bg-violet-50 text-violet-900`} title="Seeded sample data, not from your PayPal account">
      Demo data
    </span>
  );
}

/** Shown where a PayPal write or an outcome was simulated instead of sent (REQ-DIS-09). */
export function SimulatedBadge() {
  return (
    <span className={`${base} border-sky-300 bg-sky-50 text-sky-900`} title="This action was simulated; nothing was sent to PayPal">
      Simulated
    </span>
  );
}
