import type { Tone } from "@/lib/disputes/present";

const STYLE: Record<Tone, { badge: string; dot: string }> = {
  good: { badge: "border-green-300 bg-green-50 text-green-900", dot: "bg-green-600" },
  warn: { badge: "border-amber-300 bg-amber-50 text-amber-900", dot: "bg-amber-500" },
  bad: { badge: "border-red-300 bg-red-50 text-red-900", dot: "bg-red-600" },
  info: { badge: "border-sky-300 bg-sky-50 text-sky-900", dot: "bg-sky-600" },
  neutral: { badge: "border-border bg-muted text-foreground", dot: "bg-muted-foreground" },
};

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-green-800",
  warn: "text-amber-800",
  bad: "text-red-800",
  info: "text-sky-800",
  neutral: "text-foreground",
};

export const TONE_BAR: Record<Tone, string> = {
  good: "bg-green-600",
  warn: "bg-amber-500",
  bad: "bg-red-600",
  info: "bg-sky-600",
  neutral: "bg-muted-foreground",
};

/** A pill with a coloured dot. The text carries the meaning; the colour only reinforces it. */
export function ToneBadge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  const s = STYLE[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.badge}`} title={title}>
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${s.dot}`} />
      {children}
    </span>
  );
}
