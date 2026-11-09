import { SimulatedBadge } from "@/components/badges";
import type { StepStatus, TimelineStep } from "@/lib/disputes/timeline";

const DOT: Record<StepStatus, string> = {
  done: "border-green-600 bg-green-600 text-white",
  pending: "border-muted-foreground/40 bg-background text-muted-foreground",
  skipped: "border-muted-foreground/30 bg-muted text-muted-foreground",
  failed: "border-red-600 bg-red-600 text-white",
};
const ICON: Record<StepStatus, string> = { done: "✓", pending: "", skipped: "–", failed: "!" };
const STATUS_TEXT: Record<StepStatus, string> = { done: "Done", pending: "Not yet", skipped: "Skipped", failed: "Failed" };

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(iso)) + " UTC";

/** Six chronological steps with timestamps and simulated labels (REQ-DIS-10). */
export function DisputeTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <section aria-labelledby="timeline" className="rounded-xl border bg-card p-5">
      <h2 id="timeline" className="font-medium">Timeline</h2>
      <ol className="mt-4">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0">
            {i < steps.length - 1 ? <span aria-hidden="true" className="absolute left-[11px] top-6 h-full w-px bg-border" /> : null}
            <span aria-hidden="true" className={`relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${DOT[s.status]}`}>
              {ICON[s.status]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className={s.status === "pending" || s.status === "skipped" ? "text-muted-foreground" : ""}>{s.label}</span>
                <span className="sr-only">: {STATUS_TEXT[s.status]}</span>
                {s.simulated ? <SimulatedBadge /> : null}
                {s.status === "failed" ? <span className="text-xs font-medium text-red-700">Failed</span> : null}
              </p>
              <p className="text-sm text-muted-foreground">{s.detail}</p>
              {s.at ? (
                <p className="text-xs tabular-nums text-muted-foreground">
                  <time dateTime={s.at}>{when(s.at)}</time>
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
