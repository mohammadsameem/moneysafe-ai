import { describeDelta } from "@/lib/insights/present";
import type { WeightView } from "@/lib/insights/read";
import { ScoringLabel } from "@/components/scoring-label";

/** The six signal weights against their starting values, with a coloured and worded delta. */
export function WeightsTable({ weights }: { weights: WeightView[] }) {
  return (
    <section aria-labelledby="weights-heading" className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="weights-heading" className="font-medium">Signal weights</h2>
        <ScoringLabel />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        A risk score is the sum of these weights for the signals that fired on an order (capped at 100). Changes apply to orders scored from now on.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Signal weights: current value, starting value and change</caption>
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">Signal</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Current</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Starting</th>
              <th scope="col" className="py-2 pl-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {weights.map((w) => {
              const d = describeDelta(w.delta);
              return (
                <tr key={w.signal} className="border-t">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">
                    {w.label}
                    <span className="ml-2 hidden font-mono text-xs text-muted-foreground sm:inline">{w.signal}</span>
                  </th>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums">{w.current}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{w.baseline}</td>
                  <td className={`whitespace-nowrap py-2 pl-2 text-right text-xs font-medium tabular-nums sm:text-sm ${d.className}`}>
                    <span aria-hidden="true">{d.arrow} </span>
                    {d.text}
                    <span className="sr-only">, {d.spoken}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
