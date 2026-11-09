import { DemoBadge } from "@/components/badges";
import { formatDate } from "@/lib/format";
import type { InsightsView } from "@/lib/insights/read";

/** The cached summary (REQ-LL-03). Reading it never calls a model. */
export function SummaryCard({ summary, includesDemoData }: { summary: InsightsView["summary"]; includesDemoData: boolean }) {
  return (
    <section aria-labelledby="summary-heading" className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="summary-heading" className="font-medium">Summary</h2>
        {includesDemoData ? <DemoBadge /> : null}
      </div>
      <p className="mt-3 text-sm leading-relaxed">{summary.text}</p>
      {summary.note ? (
        <p role="note" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {summary.note}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        {summary.generatedAt ? `Written ${formatDate(summary.generatedAt)}. ` : ""}
        It is refreshed when an outcome is recorded or a weight proposal is decided, not when you open this page.
      </p>
    </section>
  );
}
