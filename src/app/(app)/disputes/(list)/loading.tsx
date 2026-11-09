export default function DisputesLoading() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading disputes">
      <div className="h-8 w-40 animate-pulse rounded bg-muted" />
      <div className="h-10 w-56 animate-pulse rounded bg-muted" />
      <div className="space-y-2 rounded-lg border p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-muted" />
        ))}
      </div>
      <span className="sr-only">Loading disputes…</span>
    </div>
  );
}
