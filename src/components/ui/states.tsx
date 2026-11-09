import { loadingLabel } from "@/lib/ui-errors";

/** A grey pulsing block. Decorative: the section that uses it carries the accessible label. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-muted ${className}`.trim()} />;
}

/** A card-shaped loading placeholder for one section of a page (REQ-NFR-07). */
export function SectionSkeleton({ what, rows = 3 }: { what: string; rows?: number }) {
  return (
    <section role="status" aria-busy="true" aria-label={loadingLabel(what)} className="rounded-xl border bg-card p-5">
      <Skeleton className="h-5 w-48" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className={`h-9 ${i % 2 === 0 ? "w-full" : "w-11/12"}`} />
        ))}
      </div>
      <span className="sr-only">{loadingLabel(what)}</span>
    </section>
  );
}

interface EmptyProps {
  title: string;
  children?: React.ReactNode;
  /** A next step, for example a button. */
  action?: React.ReactNode;
}

/** A dashed card that says what is missing and what to do about it (REQ-NFR-07). */
export function EmptyState({ title, children, action }: EmptyProps) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center sm:p-10">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
