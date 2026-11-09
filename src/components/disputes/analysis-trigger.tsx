"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast/toast-provider";

const MAX_IN_PROGRESS_POLLS = 15;

/**
 * Shown only when a dispute has NO stored analysis: starts POST /analyze once, shows a skeleton,
 * then refreshes the page to render the result. A dispute that is already analysed (every seed)
 * never renders this, so opening it makes no request at all.
 */
export function AnalysisTrigger({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    toast({ tone: "info", title: "Analysing this dispute", description: "Weighing the evidence and drafting a response. This takes a few seconds." });
    try {
      for (let poll = 0; poll <= MAX_IN_PROGRESS_POLLS; poll++) {
        const response = await fetch(`/api/disputes/${disputeId}/analyze`, { method: "POST" });
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (response.status === 202) {
          // Someone else is analysing it; nothing is spent by waiting. Ask again shortly.
          const wait = Number(response.headers.get("retry-after") ?? "2");
          await new Promise((r) => setTimeout(r, Math.min(10, Math.max(1, wait)) * 1000));
          continue;
        }
        if (!response.ok) throw new Error(String(response.status));
        toast({ tone: "success", title: "Analysis ready", description: "Review the recommendation, then approve or reject." });
        router.refresh();
        return;
      }
      setError("The analysis is taking longer than expected.");
      toast({ tone: "error", title: "The analysis is taking too long", description: "Nothing was decided. Try again." });
    } catch {
      setError("The analysis could not be completed.");
      toast({ tone: "error", title: "The analysis could not be completed", description: "Nothing was decided and nothing was sent to PayPal." });
    }
  }, [disputeId, router, toast]);

  useEffect(() => {
    if (started.current) return; // React may run effects twice in development
    started.current = true;
    void run();
  }, [run]);

  if (error) {
    return (
      <div role="alert" className="space-y-3 rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-900">
        <p>{error} No decision has been made and nothing was sent to PayPal.</p>
        <button
          type="button"
          onClick={() => void run()}
          className="rounded-md border bg-background px-4 py-2 font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <div className="rounded-xl border bg-card p-5">
        <p className="font-medium">Analysing this dispute…</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Weighing the evidence on file and drafting a response. This usually takes a few seconds and never more than about half a minute.
        </p>
        <div className="mt-4 space-y-2">
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="h-32 animate-pulse rounded-xl border bg-muted/40" />
    </div>
  );
}
