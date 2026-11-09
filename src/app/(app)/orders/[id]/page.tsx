import Link from "next/link";
import { notFound } from "next/navigation";
import { DemoBadge, RiskBadge } from "@/components/badges";
import { formatDate, formatUsd, shortId, signalLabel } from "@/lib/format";
import { createDrizzleReadRepo, toOrderDetail } from "@/lib/orders/queries";
import { ORDER_NOTICES, isOrderNoticeKey } from "@/lib/orders/notices";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";

const FALLBACK_NOTE = "AI unavailable \u2014 showing rule-based result.";

export default async function OrderDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { notice?: string } }) {
  const sessionId = await getSessionId();
  const row = sessionId ? await createDrizzleReadRepo().findVisible(params.id, sessionId) : null;
  if (!row) notFound();
  const order = toOrderDetail(row);
  const notice = isOrderNoticeKey(searchParams.notice) ? ORDER_NOTICES[searchParams.notice] : null;
  const scored = order.riskScore !== null;
  const active = order.signalBreakdown.filter((s) => s.active);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link href="/orders" className="text-sm text-muted-foreground underline-offset-2 hover:underline">← Orders</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Order <span className="font-mono">{shortId(order.id)}</span></h1>
          <RiskBadge verdict={order.verdict} score={order.riskScore} />
          {order.isDemo ? <DemoBadge /> : null}
        </div>
      </div>

      {notice ? <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">{notice}</p> : null}

      <section aria-labelledby="summary" className="rounded-lg border bg-card p-4">
        <h2 id="summary" className="mb-3 font-medium">Summary</h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Fact label="Buyer" value={order.buyerEmail} />
          <Fact label="Amount" value={formatUsd(order.amountUsd, order.currency)} />
          <Fact label="Date" value={formatDate(order.createdAt)} />
          <Fact label="Status" value={order.status} />
          <Fact label="Shipping" value={`${order.shippingMethod} · ${order.billingCountry} billing → ${order.shippingCountry} shipping`} />
          <Fact label="Buyer history" value={order.buyerIsFirstTime ? "First-time buyer" : "Returning buyer"} />
          <Fact label="Payment attempts" value={String(order.paymentAttemptCount)} />
          {order.evidenceCompleteness !== null ? <Fact label="Evidence completeness" value={`${order.evidenceCompleteness}%`} /> : null}
        </dl>
      </section>

      <section aria-labelledby="score" className="rounded-lg border bg-card p-4">
        <h2 id="score" className="mb-3 font-medium">Risk score</h2>
        {scored ? (
          <>
            <p className="text-3xl font-semibold tabular-nums">{order.riskScore}<span className="text-base font-normal text-muted-foreground"> / 100</span></p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Signal breakdown</caption>
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1 pr-4 font-medium">Signal</th>
                    <th scope="col" className="py-1 pr-4 font-medium">Fired</th>
                    <th scope="col" className="py-1 text-right font-medium">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {order.signalBreakdown.map((s) => (
                    <tr key={s.signal} className={`border-t ${s.active ? "" : "text-muted-foreground"}`}>
                      <th scope="row" className="py-1.5 pr-4 text-left font-normal">{signalLabel(s.signal)}</th>
                      <td className="py-1.5 pr-4">{s.active ? "Yes" : "No"}</td>
                      <td className="py-1.5 text-right tabular-nums">{s.active ? `+${s.weight}` : "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {order.status === "created" ? "Waiting for the buyer to approve the payment in PayPal." : order.status === "cancelled" ? "This order was cancelled before payment." : "Not scored yet."}
          </p>
        )}
      </section>

      {scored && order.riskScore !== null && order.riskScore >= 1 ? (
        <section aria-labelledby="ai" className="rounded-lg border bg-card p-4">
          <h2 id="ai" className="mb-2 font-medium">Why this score</h2>
          {order.aiExplanation ? <p className="whitespace-pre-line text-sm leading-relaxed">{order.aiExplanation}</p> : (
            <p className="text-sm text-muted-foreground">
              {active.length > 0 ? `Signals fired: ${active.map((s) => signalLabel(s.signal)).join("; ")}.` : "No explanation is available."}
            </p>
          )}
          {order.usedFallback ? <p className="mt-3 text-xs text-muted-foreground">{FALLBACK_NOTE}</p> : null}
        </section>
      ) : null}

      {order.verdict === "verify" ? (
        <section aria-labelledby="draft" className="rounded-lg border bg-card p-4">
          <h2 id="draft" className="mb-1 font-medium">Draft message to the buyer</h2>
          <p className="mb-3 text-xs text-muted-foreground">Review it before you send it. Nothing is sent automatically.</p>
          {order.verificationDraft ? (
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <p className="font-medium">{order.verificationDraft.subject}</p>
              <p className="mt-2 whitespace-pre-line leading-relaxed">{order.verificationDraft.body}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No draft has been written for this order yet.</p>
          )}
          {order.usedFallback ? <p className="mt-3 text-xs text-muted-foreground">{FALLBACK_NOTE}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
