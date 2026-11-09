"use client";

import { describeError } from "@/lib/ui-errors";

/** Last resort: the root layout itself failed, so this page brings its own <html> and <body>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const view = describeError(error, "the app");
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem", background: "#fff", color: "#0f172a" }}>
        <main style={{ maxWidth: "32rem", margin: "4rem auto" }}>
          <div role="alert" style={{ border: "1px solid #fca5a5", background: "#fef2f2", borderRadius: "0.75rem", padding: "1.5rem" }}>
            <h1 style={{ fontSize: "1.125rem", margin: 0 }}>{view.title}</h1>
            <p style={{ fontSize: "0.875rem" }}>{view.message}</p>
            {view.reference ? <p style={{ fontFamily: "monospace", fontSize: "0.75rem" }}>Reference: {view.reference}</p> : null}
            <button type="button" onClick={() => reset()} style={{ marginTop: "0.75rem", padding: "0.6rem 1rem", borderRadius: "0.5rem", border: "1px solid #94a3b8", background: "#fff", cursor: "pointer" }}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
