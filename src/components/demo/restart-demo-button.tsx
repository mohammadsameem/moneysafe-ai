"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast/toast-provider";

interface RestartBody {
  message?: string;
  deleted?: { orders: number; disputes: number };
}

/**
 * Restart my demo (REQ-DU-03): clears only THIS session's own orders, disputes and activity so
 * Start demo can make fresh copies. No dialog: it cannot affect anyone else or the shared data.
 */
export function RestartDemoButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function restart() {
    setBusy(true);
    try {
      const response = await fetch("/api/demo/restart", { method: "POST" });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as RestartBody | null;
      if (response.ok) {
        const d = body?.deleted;
        toast({
          tone: "success",
          title: "Your demo was restarted",
          description: d && (d.disputes > 0 || d.orders > 0) ? `Removed your ${d.disputes} dispute(s) and ${d.orders} order(s). Click Start demo for fresh copies.` : "You had nothing to clear. Click Start demo for your copies.",
        });
        router.refresh();
      } else {
        toast({ tone: "error", title: "Your demo could not be restarted", description: body?.message ?? `The server answered HTTP ${response.status}. Nothing was changed.` });
      }
    } catch {
      toast({ tone: "error", title: "Your demo could not be restarted", description: "We could not reach the server. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void restart()}
        disabled={busy}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
      >
        {busy ? "Restarting…" : "Restart my demo"}
      </button>
      <p className="mt-1 text-xs text-muted-foreground">Clears only your own orders, disputes and activity.</p>
    </div>
  );
}
