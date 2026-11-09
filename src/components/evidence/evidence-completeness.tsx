import type { CompletenessItem } from "@/lib/scoring";

const toneFor = (score: number) => (score >= 85 ? { ring: "stroke-green-600", text: "text-green-800" } : score >= 60 ? { ring: "stroke-amber-500", text: "text-amber-800" } : { ring: "stroke-red-600", text: "text-red-800" });

/** Progress ring and the REQ-EV-02 checklist, with the tracking artefact split into its two sub-criteria. */
export function EvidenceCompleteness({ score, breakdown }: { score: number; breakdown: CompletenessItem[] }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const t = toneFor(score);
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <div className="relative mx-auto h-24 w-24 shrink-0 sm:mx-0" role="img" aria-label={`Evidence completeness ${score}%`}>
        <svg viewBox="0 0 80 80" className="h-24 w-24 -rotate-90" aria-hidden="true">
          <circle cx="40" cy="40" r={r} className="fill-none stroke-muted" strokeWidth="8" />
          <circle cx="40" cy="40" r={r} className={`fill-none ${t.ring}`} strokeWidth="8" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} />
        </svg>
        <span className={`absolute inset-0 flex items-center justify-center text-xl font-semibold tabular-nums ${t.text}`}>{score}%</span>
      </div>
      <ul className="grid flex-1 gap-1.5 text-sm" aria-label="Evidence checklist">
        {breakdown.map((item) => (
          <li key={item.criterion} className={`flex items-center justify-between gap-3 rounded-md px-2 py-1 ${item.met ? "" : "text-muted-foreground"}`}>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${item.met ? "bg-green-600 text-white" : "border border-muted-foreground/40"}`}>
                {item.met ? "✓" : ""}
              </span>
              <span>{item.label}</span>
              <span className="sr-only">{item.met ? ": on file" : ": missing"}</span>
            </span>
            <span className="tabular-nums">
              {item.points} / {item.max}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
