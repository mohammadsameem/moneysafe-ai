"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const SHIPPING = [
  { value: "standard", label: "Standard" },
  { value: "express", label: "Express" },
  { value: "overnight", label: "Overnight" },
  { value: "rush", label: "Rush" },
] as const;

const field = "mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface Issue {
  field: string;
  message: string;
}

/**
 * "New sandbox order" (REQ-ORD-08). Creates a PayPal sandbox order and sends you to PayPal to
 * approve it as the buyer. If PayPal is not used, a demo order is made and opened instead.
 */
export function NewOrderForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemName: String(form.get("itemName") ?? ""),
          amountUsd: Number(form.get("amountUsd")),
          shippingMethod: String(form.get("shippingMethod") ?? ""),
          billingCountry: String(form.get("billingCountry") ?? ""),
          shippingCountry: String(form.get("shippingCountry") ?? ""),
          paymentAttemptCount: Number(form.get("paymentAttemptCount") || 1),
        }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { orderId?: string; approvalUrl?: string | null; issues?: Issue[] } | null;
      if (response.status === 400 && body?.issues) {
        setIssues(body.issues);
        return;
      }
      if (!response.ok || !body?.orderId) {
        setError("We could not create the order. Please try again.");
        return;
      }
      if (body.approvalUrl && body.approvalUrl.startsWith("https://")) {
        window.location.assign(body.approvalUrl); // PayPal sandbox approval page
      } else {
        router.push(`/orders/${body.orderId}`); // demo order: already scored
      }
    } catch {
      setError("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const issueFor = (name: string) => issues.find((i) => i.field === name)?.message;

  return (
    <details className="rounded-lg border bg-card">
      <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        New sandbox order
      </summary>
      <form onSubmit={onSubmit} className="grid gap-4 border-t p-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2">
          <label htmlFor="itemName" className="text-sm font-medium">Item</label>
          <input id="itemName" name="itemName" required maxLength={127} defaultValue="Hand-knitted throw blanket" className={field} aria-describedby="itemName-error" />
          <p id="itemName-error" className="mt-1 text-xs text-destructive">{issueFor("itemName")}</p>
        </div>
        <div>
          <label htmlFor="amountUsd" className="text-sm font-medium">Amount (USD)</label>
          <input id="amountUsd" name="amountUsd" type="number" inputMode="decimal" step="0.01" min="0.01" max="10000" required defaultValue="120" className={field} aria-describedby="amountUsd-error" />
          <p id="amountUsd-error" className="mt-1 text-xs text-destructive">{issueFor("amountUsd")}</p>
        </div>
        <div>
          <label htmlFor="shippingMethod" className="text-sm font-medium">Shipping method</label>
          <select id="shippingMethod" name="shippingMethod" defaultValue="standard" className={field}>
            {SHIPPING.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-destructive">{issueFor("shippingMethod")}</p>
        </div>
        <div>
          <label htmlFor="billingCountry" className="text-sm font-medium">Billing country (2 letters)</label>
          <input id="billingCountry" name="billingCountry" required minLength={2} maxLength={2} defaultValue="US" autoCapitalize="characters" className={field} aria-describedby="billingCountry-error" />
          <p id="billingCountry-error" className="mt-1 text-xs text-destructive">{issueFor("billingCountry")}</p>
        </div>
        <div>
          <label htmlFor="shippingCountry" className="text-sm font-medium">Shipping country (2 letters)</label>
          <input id="shippingCountry" name="shippingCountry" required minLength={2} maxLength={2} defaultValue="US" autoCapitalize="characters" className={field} aria-describedby="shippingCountry-error" />
          <p id="shippingCountry-error" className="mt-1 text-xs text-destructive">{issueFor("shippingCountry")}</p>
        </div>
        <div>
          <label htmlFor="paymentAttemptCount" className="text-sm font-medium">Payment attempts</label>
          <input id="paymentAttemptCount" name="paymentAttemptCount" type="number" min="1" max="10" step="1" defaultValue="1" className={field} aria-describedby="paymentAttemptCount-error" />
          <p id="paymentAttemptCount-error" className="mt-1 text-xs text-destructive">{issueFor("paymentAttemptCount")}</p>
        </div>
        <div className="flex items-end justify-end sm:col-span-2">
          <div className="flex-1">
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create and open PayPal"}
          </button>
        </div>
      </form>
    </details>
  );
}
