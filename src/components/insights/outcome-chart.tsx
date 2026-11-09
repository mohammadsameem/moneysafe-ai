import { DemoBadge } from "@/components/badges";
import { TONE_BAR } from "@/components/tone-badge";
import { outcomeBars } from "@/lib/insights/present";
import type { InsightsView } from "@/lib/insights/read";

/** Won / lost / refunded as plain bars with their counts written out (no chart library, no colour-only meaning). */
export function OutcomeChart({ outcomes }: { outcomes: InsightsView["outcomes"] }) {
  const bars = outcomeBars(outcomes);
  return (
    <section aria-labelledby="outcomes-heading" className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="outcomes-heading" className="font-medium">How disputes ended</h2>
        {outcomes.includesDemoData ? <DemoBadge /> : null}
      </div>
      {outcomes.total === 0 ? (
        <p className="mt-4 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          No disputes have been resolved yet. When one is won, lost or refunded, it appears here and feeds the weight proposals.
        </p>
      ) : (
        <>
          <ul className="mt-4 space-y-3">
            {bars.map((b) => (
              <li key={b.key} className="grid grid-cols-[5.5rem_1fr_2rem] items-center gap-3 text-sm">
                <span>{b.label}</span>
                <span className="h-3 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span className={`block h-full rounded-full ${TONE_BAR[b.tone]}`} style={{ width: `${b.widthPercent}%` }} />
                </span>
                <span className="text-right font-semibold tabular-nums">{b.count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            {outcomes.total} resolved in total
            {outcomes.simulated > 0 ? `, ${outcomes.simulated} of them recorded as simulated outcomes` : ""}
            {outcomes.seeded > 0 ? `, ${outcomes.seeded} from the demo history` : ""}.
          </p>
        </>
      )}
    </section>
  );
}
