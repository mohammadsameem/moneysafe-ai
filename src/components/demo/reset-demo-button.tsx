"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useToast } from "@/components/toast/toast-provider";

/**
 * Reset everything for all judges (REQ-DU-01). Opens a confirmation first, because the reset is
 * shared: it puts the demo back to its starting state for every visitor. A second reset within
 * 10 seconds is refused by the server and shown as a cooldown message.
 */
export function ResetDemoButton() {
  const router = useRouter();
  const { toast } = useToast();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      const response = await fetch("/api/demo/reset", { method: "POST" });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (response.ok) {
        toast({ tone: "success", title: "Demo reset for everyone", description: "Orders, disputes, copies, weights and activity are back to the starting data." });
        dialog.current?.close();
        router.refresh();
      } else if (response.status === 429) {
        dialog.current?.close();
        toast({ tone: "info", title: "Reset is cooling down", description: body?.message ?? "The demo was reset a moment ago. Try again in a few seconds." });
      } else {
        toast({ tone: "error", title: "The demo could not be reset", description: body?.message ?? `The server answered HTTP ${response.status}. Nothing was changed.` });
      }
    } catch {
      toast({ tone: "error", title: "The demo could not be reset", description: "We could not reach the server. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Reset everything for all judges
      </button>
      <dialog ref={dialog} aria-labelledby="reset-title" className="w-[min(92vw,28rem)] rounded-xl border bg-card p-6 shadow-xl backdrop:bg-black/40">
        <h2 id="reset-title" className="text-lg font-semibold">Reset the demo for everyone?</h2>
        <p className="mt-2 text-sm">This resets data for all judges.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Orders, disputes and demo copies created by anyone are deleted.</li>
          <li>The seeded orders, disputes, history and agent activity come back.</li>
          <li>Signal weights return to their starting values and the sample weight proposal is pending again.</li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">To clear only your own data, use &ldquo;Restart my demo&rdquo; instead.</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void reset()}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {busy ? "Resetting…" : "Reset for everyone"}
          </button>
        </div>
      </dialog>
    </>
  );
}
