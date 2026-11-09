import { TONE_BAR, TONE_TEXT, ToneBadge } from "@/components/tone-badge";
import { LIKELIHOOD_TONE, adjustmentText, percent, type LikelihoodLabel } from "@/lib/disputes/present";

/** "Estimated win likelihood": a % bar with Strong / Moderate / Weak and where the number came from. */
export function WinLikelihoodMeter({ probability, label, llmAdjustment }: { probability: number; label: LikelihoodLabel; llmAdjustment: number | null }) {
  const pct = percent(probability);
  const tone = LIKELIHOOD_TONE[label];
  const adjusted = llmAdjustment !== null && Math.round(llmAdjustment * 100) !== 0;

  return (
    <section aria-labelledby="win-likelihood" className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="win-likelihood" className="text-sm font-medium text-muted-foreground">Estimated win likelihood</h2>
          <p className={`mt-1 text-4xl font-semibold tabular-nums ${TONE_TEXT[tone]}`}>{pct}%</p>
        </div>
        <ToneBadge tone={tone}>{label}</ToneBadge>
      </div>
      <div
        role="meter"
        aria-label="Estimated win likelihood"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%, ${label}`}
        className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground" aria-hidden="true">
        <span>Weak</span>
        <span>40%</span>
        <span>70%</span>
        <span>Strong</span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">{adjusted ? "AI-adjusted estimate" : "System estimate"}</span>{" "}
        Computed from the evidence on file{adjusted ? `; ${adjustmentText(llmAdjustment)}` : ""}. Estimates are capped between 5% and 95%.
      </p>
    </section>
  );
}
