"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const field = "mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Append one buyer message to the evidence (append-only; REQ-EV-01 "buyer communications"). */
export function LogMessageForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const response = await fetch(`/api/orders/${orderId}/evidence/communication`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction: String(form.get("direction")), subject: String(form.get("subject") ?? ""), body: String(form.get("body") ?? "") }),
      });
      const body = (await response.json().catch(() => null)) as { message?: string; issues?: { field: string; message: string }[] } | null;
      if (!response.ok) {
        setError(body?.issues?.[0] ? `${body.issues[0].field} ${body.issues[0].message}.` : body?.message ?? "The message could not be saved.");
        return;
      }
      formEl.reset();
      setDone(true);
      router.refresh();
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Log a buyer message</summary>
      <form onSubmit={onSubmit} className="grid gap-3 border-t p-3 sm:grid-cols-2" noValidate>
        <div>
          <label htmlFor="direction" className="text-sm font-medium">Direction</label>
          <select id="direction" name="direction" defaultValue="inbound" className={field}>
            <option value="inbound">From the buyer</option>
            <option value="outbound">To the buyer</option>
          </select>
        </div>
        <div>
          <label htmlFor="subject" className="text-sm font-medium">Subject</label>
          <input id="subject" name="subject" required maxLength={150} className={field} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="body" className="text-sm font-medium">Message</label>
          <textarea id="body" name="body" required maxLength={2000} rows={3} className={field} />
        </div>
        <div className="flex items-center justify-between gap-2 sm:col-span-2">
          <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>{error ?? (done ? "Saved to the evidence." : "")}</p>
          <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            {busy ? "Saving…" : "Save message"}
          </button>
        </div>
      </form>
    </details>
  );
}
