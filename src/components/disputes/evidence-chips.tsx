/** Evidence the analysis relied on, and what is missing (REQ-DIS-03). */
export function EvidenceChips({ used, gaps }: { used: string[]; gaps: string[] }) {
  return (
    <section aria-label="Evidence" className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-2">
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">Evidence used</h2>
        {used.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing on file yet.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {used.map((e) => (
              <li key={e} className="inline-flex items-center gap-1.5 rounded-full border border-green-300 bg-green-50 px-2.5 py-1 text-xs text-green-900">
                <span aria-hidden="true">✓</span>
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">Evidence gaps</h2>
        {gaps.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No gaps found.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {gaps.map((e) => (
              <li key={e} className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-900">
                <span aria-hidden="true">!</span>
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
