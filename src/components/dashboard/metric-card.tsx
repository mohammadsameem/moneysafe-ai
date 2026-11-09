import { DemoBadge } from "@/components/badges";

interface Props {
  label: string;
  /** The headline figure, already formatted. */
  value: string;
  /** What the figure counts, in a few words. */
  detail: string;
  /** An extra emphasised line (for example the simulated part of Dollars protected). */
  highlight?: string;
  /** Seeded history contributes to this figure (the Demo data badge, REQ-DEMO-06). */
  demo?: boolean;
}

export function MetricCard({ label, value, detail, highlight, demo = false }: Props) {
  return (
    <section aria-label={label} className="flex flex-col rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
        {demo ? <DemoBadge /> : null}
      </div>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      {highlight ? <p className="mt-1 text-sm font-medium text-sky-800">{highlight}</p> : null}
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </section>
  );
}
