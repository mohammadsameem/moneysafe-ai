import { OutcomeChart } from "@/components/insights/outcome-chart";
import { SummaryCard } from "@/components/insights/summary-card";
import { WeightChangeProposal } from "@/components/insights/weight-change-proposal";
import { WeightsTable } from "@/components/insights/weights-table";
import { getDb } from "@/db/client";
import { progressText } from "@/lib/insights/present";
import { loadInsights } from "@/lib/insights/read";
import { createDrizzleInsightsRepo } from "@/lib/insights/repo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights · MoneySafe AI" };

/**
 * Insights (REQ-LL-03). Server-rendered from the database and the CACHED summary; opening this
 * page never calls a model.
 */
export default async function InsightsPage() {
  const view = await loadInsights(createDrizzleInsightsRepo(getDb()));

  if (!view) {
    return (
      <div className="max-w-2xl space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-5 text-sm text-red-900">
          The demo data has not been loaded, so there are no signal weights to show. Run <code className="font-mono">npm run db:seed</code> and reload.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
        <p className="text-sm text-muted-foreground">How resolved disputes tune the explainable risk signals. Nothing changes until you approve it.</p>
        <p className="text-xs text-muted-foreground">Signal weights are shared across the demo: a change you approve applies for every visitor until the demo is reset.</p>
      </header>

      {view.proposal ? <WeightChangeProposal proposal={view.proposal} /> : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <WeightsTable weights={view.weights} />
          <p className="text-sm text-muted-foreground">{progressText(view.progress)}</p>
        </div>
        <div className="space-y-6 lg:col-span-2">
          <OutcomeChart outcomes={view.outcomes} />
          <SummaryCard summary={view.summary} includesDemoData={view.outcomes.includesDemoData} />
        </div>
      </div>
    </div>
  );
}
