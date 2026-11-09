import { describeError } from "@/lib/ui-errors";

interface Props {
  /** The thing that failed, for the sentence "We could not show ...". */
  what?: string;
  error?: { digest?: string | undefined };
  onRetry?: () => void;
  retrying?: boolean;
  /** A smaller card for a section inside a page. */
  compact?: boolean;
}

/** An error card with a Try again button (REQ-NFR-07). Presentational: the parent decides what retry does. */
export function ErrorCard({ what, error = {}, onRetry, retrying = false, compact = false }: Props) {
  const view = describeError(error, what);
  return (
    <div role="alert" className={`rounded-xl border border-red-300 bg-red-50 text-red-950 ${compact ? "p-4" : "p-6"}`}>
      <h2 className="font-medium">{view.title}</h2>
      <p className="mt-1 text-sm">{view.message}</p>
      {view.reference ? <p className="mt-2 font-mono text-xs text-red-900/80">Reference: {view.reference}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-3 rounded-md border border-red-300 bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {retrying ? "Trying again…" : "Try again"}
        </button>
      ) : null}
    </div>
  );
}
