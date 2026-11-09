export default function OrdersLoading() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading orders">
      <div className="h-8 w-40 animate-pulse rounded bg-muted" />
      <div className="h-12 animate-pulse rounded-lg bg-muted" />
      <div className="space-y-2 rounded-lg border p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-muted" />
        ))}
      </div>
      <span className="sr-only">Loading orders…</span>
    </div>
  );
}
