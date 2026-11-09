"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast/toast-provider";

interface Props {
  /** Open this seed's copy afterwards (on a shared example's page); otherwise go to the Disputes inbox. */
  seedDisputeId?: string;
  className?: string;
}

interface StartDemoBody {
  status?: "created" | "existing";
  copies?: { seedDisputeId: string; disputeId: string }[];
  message?: string;
}

/**
 * "Start demo" (M3-08): creates this session's own copies of the three open example disputes, with
 * their stored analysis. Safe to click again: it then just opens the existing copies.
 */
export function StartDemoButton({ seedDisputeId, className }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/start", { method: "POST" });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as StartDemoBody | null;
      if (!response.ok || !body?.copies) {
        const text = body?.message ?? "The demo could not be started. Please try again.";
        setError(text);
        toast({ tone: "error", title: "The demo could not be started", description: text });
        return;
      }
      toast(
        body.status === "created"
          ? { tone: "success", title: "Your demo is ready", description: "You have your own copies of the three example disputes. Open the SEED-C copy to start." }
          : { tone: "info", title: "You already have your copies", description: "Opening them." },
      );
      const target = seedDisputeId ? body.copies.find((c) => c.seedDisputeId === seedDisputeId) : undefined;
      router.push(target ? `/disputes/${target.disputeId}` : "/disputes");
      router.refresh();
    } catch {
      setError("We could not reach the server. Please try again.");
      toast({ tone: "error", title: "We could not reach the server", description: "The demo was not started. Try again." });
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
        className={
          className ??
          "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        }
      >
        {busy ? "Starting…" : "Start demo"}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
