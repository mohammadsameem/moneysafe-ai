import type { DisputeAnalysisView } from "@/lib/disputes/read";
import { RECOMMENDATION_LABEL, sourceLabel } from "@/lib/disputes/present";

export const FALLBACK_NOTE = "AI unavailable \u2014 showing rule-based result.";

/** The recommendation, who made it (system or AI-adjusted), and why. */
export function RecommendationCard({ analysis }: { analysis: DisputeAnalysisView }) {
  const rec = analysis.finalRecommendation ?? analysis.systemRecommendation ?? "refund";
  const overridden = analysis.recommendationSource === "ai_adjusted" && analysis.systemRecommendation !== null;
  const style = rec === "contest" ? "bg-slate-900 text-white" : "bg-white text-slate-900 ring-1 ring-inset ring-slate-300";

  return (
    <section aria-labelledby="recommendation" className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="recommendation" className="text-sm font-medium text-muted-foreground">Recommendation</h2>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">{sourceLabel(analysis.recommendationSource)}</span>
      </div>
      <p className="mt-3">
        <span className={`inline-flex items-center rounded-lg px-4 py-1.5 text-lg font-semibold ${style}`}>{RECOMMENDATION_LABEL[rec]}</span>
      </p>
      {overridden ? (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          The system recommended <strong>{RECOMMENDATION_LABEL[analysis.systemRecommendation!].toLowerCase()}</strong>; the AI changed it to{" "}
          <strong>{RECOMMENDATION_LABEL[rec].toLowerCase()}</strong> for the reason below.
        </p>
      ) : null}
      {analysis.reasoning ? <p className="mt-3 whitespace-pre-line text-sm leading-relaxed">{analysis.reasoning}</p> : null}
      {analysis.aiUnavailable ? (
        <p role="note" className="mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {FALLBACK_NOTE} The win likelihood is not shown because the AI step did not run; the recommendation comes from the expected-value rule.
        </p>
      ) : null}
    </section>
  );
}
