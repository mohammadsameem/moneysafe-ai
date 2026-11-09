import { DemoBadge } from "@/components/badges";
import { ScoringLabel } from "@/components/scoring-label";
import { donutSegments, donutSummary } from "@/lib/dashboard/present";
import type { DashboardMetrics } from "@/lib/dashboard/metrics";

/** Orders by verdict as a donut drawn in SVG, with the counts repeated in words (REQ-DASH-03). */
export function RiskDonut({ distribution }: { distribution: DashboardMetrics["verdict_distribution"] }) {
  const counts = { ship: distribution.ship, verify: distribution.verify, hold: distribution.hold };
  const segments = donutSegments(counts);
  const holdCount = distribution.hold;

  return (
    <section aria-labelledby="risk-heading" className="self-start rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="risk-heading" className="font-medium">Risk distribution</h2>
        {distribution.includesDemoData ? <DemoBadge /> : null}
      </div>
      {distribution.total === 0 ? (
        <p className="mt-4 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          No scored orders yet. Create an order and its risk verdict appears here.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-6">
          <svg viewBox="0 0 42 42" className="h-36 w-36 shrink-0" role="img" aria-label={donutSummary(counts)}>
            <circle cx="21" cy="21" r="15.9155" fill="none" stroke="#e5e7eb" strokeWidth="6" />
            {segments
              .filter((s) => s.count > 0)
              .map((s) => (
                <circle
                  key={s.key}
                  cx="21"
                  cy="21"
                  r="15.9155"
                  fill="none"
                  stroke={s.color}
                  strokeWidth="6"
                  strokeDasharray={s.dashArray}
                  strokeDashoffset={s.dashOffset}
                  transform="rotate(-90 21 21)"
                />
              ))}
            <text x="21" y="22.5" textAnchor="middle" className="fill-current text-[8px] font-semibold">{distribution.total}</text>
            <text x="21" y="28" textAnchor="middle" className="fill-current text-[3px] text-muted-foreground">orders</text>
          </svg>
          <ul className="space-y-2 text-sm">
            {segments.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="w-24">{s.label}</span>
                <span className="font-semibold tabular-nums">{s.count}</span>
                <span className="text-xs text-muted-foreground">({s.percent}%)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ScoringLabel className="mt-4" />
      {holdCount > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {holdCount} {holdCount === 1 ? "order" : "orders"} on Hold {holdCount === 1 ? "needs" : "need"} attention
        </p>
      ) : null}
    </section>
  );
}
