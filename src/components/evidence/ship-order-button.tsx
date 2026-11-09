"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const CARRIERS = [
  { value: "USPS", label: "USPS" },
  { value: "UPS", label: "UPS" },
  { value: "FEDEX", label: "FedEx" },
  { value: "DHL", label: "DHL" },
  { value: "OTHER", label: "Other" },
] as const;
const field = "mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const primary = "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

/** "Mark as shipped": a modal with the tracking number and carrier (REQ-EV-01). */
export function ShipOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const d = dialog.current;
    const onClose = () => setError(null);
    d?.addEventListener("close", onClose);
    return () => d?.removeEventListener("close", onClose);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${orderId}/ship`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackingNumber: String(form.get("trackingNumber") ?? "").trim(), carrier: String(form.get("carrier") ?? "") }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { status?: string; warnings?: string[]; message?: string; issues?: { message: string }[] } | null;
      if (!response.ok || body?.status !== "shipped") {
        setError(body?.issues?.[0] ? `Tracking number ${body.issues[0].message}.` : body?.message ?? "The order could not be marked as shipped.");
        return;
      }
      setWarnings(body.warnings ?? []);
      dialog.current?.close();
      router.refresh();
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={primary} onClick={() => dialog.current?.showModal()}>
        Mark as shipped
      </button>
      {warnings.length > 0 ? (
        <div role="status" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}
      <dialog ref={dialog} aria-labelledby="ship-title" className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40">
        <form onSubmit={onSubmit} className="space-y-4 p-5" noValidate>
          <div>
            <h2 id="ship-title" className="text-lg font-semibold">Mark as shipped</h2>
            <p className="mt-1 text-sm text-muted-foreground">We record the tracking details and assemble the evidence for this order. Stored evidence is never changed later.</p>
          </div>
          <div>
            <label htmlFor="trackingNumber" className="text-sm font-medium">Tracking number</label>
            <input id="trackingNumber" name="trackingNumber" required minLength={4} maxLength={40} pattern="[A-Za-z0-9\-]{4,40}" autoComplete="off" className={field} aria-describedby="tracking-help" />
            <p id="tracking-help" className="mt-1 text-xs text-muted-foreground">Letters, digits and dashes. Scan events are mocked in this demo; a number ending in X stays In Transit.</p>
          </div>
          <div>
            <label htmlFor="carrier" className="text-sm font-medium">Carrier</label>
            <select id="carrier" name="carrier" defaultValue="USPS" className={field}>
              {CARRIERS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className={primary} disabled={busy}>
              {busy ? "Saving…" : "Mark as shipped"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
