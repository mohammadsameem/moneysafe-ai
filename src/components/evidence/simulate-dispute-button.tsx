"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** "Simulate dispute" (REQ-DU-02): opens a synthetic dispute on this shipped order, for this session only. */
export function SimulateDisputeButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/disputes/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId }) });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { disputeId?: string; message?: string } | null;
      if ((response.ok || response.status === 409) && body?.disputeId) {
        router.push(`/disputes/${body.disputeId}`);
        return;
      }
      setError(body?.message ?? "The dispute could not be created.");
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-md border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-950 hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy ? "Creating…" : "Simulate dispute"}
      </button>
      {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
