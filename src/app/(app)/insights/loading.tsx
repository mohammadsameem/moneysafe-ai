/** Insights loading skeleton (REQ-NFR-07). */
export default function InsightsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6" aria-busy="true" aria-label="Loading insights">
      <div className="space-y-2">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-muted" />
      </div>
      <div className="h-56 animate-pulse rounded-xl bg-muted" />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="h-72 animate-pulse rounded-xl bg-muted lg:col-span-3" />
        <div className="space-y-6 lg:col-span-2">
          <div className="h-40 animate-pulse rounded-xl bg-muted" />
          <div className="h-40 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    </div>
  );
}
