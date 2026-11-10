"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast/toast-provider";

/** "Check PayPal for disputes": links real PayPal disputes that belong to this session's own real orders. */
export function SyncPayPalButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const response = await fetch("/api/disputes/sync", { method: "POST" });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { status?: string; message?: string; linked?: Array<{ created: boolean }> } | null;
      if (!response.ok || body?.status !== "ok") {
        toast({ tone: "error", title: "Could not check PayPal", description: body?.message ?? "Try again in a moment." });
        return;
      }
      const linked = body.linked ?? [];
      const fresh = linked.filter((l) => l.created).length;
      toast(
        linked.length === 0
          ? { tone: "info", title: "No PayPal disputes found for your orders", description: "Only disputes on real orders you created in this session are linked." }
          : { tone: "success", title: fresh > 0 ? `Linked ${fresh} PayPal dispute${fresh === 1 ? "" : "s"}` : "Already up to date", description: "They appear in the Open list." },
      );
      router.refresh();
    } catch {
      toast({ tone: "error", title: "Could not check PayPal", description: "Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {busy ? "Checking PayPal…" : "Check PayPal for disputes"}
    </button>
  );
}
