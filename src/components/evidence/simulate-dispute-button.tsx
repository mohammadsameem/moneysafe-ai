"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast/toast-provider";

/** "Simulate dispute" (REQ-DU-02): opens a synthetic dispute on this shipped order, for this session only. */
export function SimulateDisputeButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { toast } = useToast();
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
        toast(
          response.ok
            ? { tone: "success", title: "Simulated dispute opened", description: "It is analysed when you open it. Nothing is sent to PayPal." }
            : { tone: "info", title: "You already simulated a dispute on this order", description: "Opening it." },
        );
        router.push(`/disputes/${body.disputeId}`);
        return;
      }
      const text = body?.message ?? "The dispute could not be created.";
      setError(text);
      toast({ tone: "error", title: "The dispute could not be created", description: text });
    } catch {
      setError("We could not reach the server. Please try again.");
      toast({ tone: "error", title: "We could not reach the server", description: "No dispute was created. Try again." });
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
