import { actionLabel, type LiveDisputeInfo } from "@/lib/disputes/paypal-reason";

const UTC = (iso: string) => new Date(iso).toUTCString().replace(" GMT", " UTC");
const humanise = (code: string) => code.toLowerCase().replace(/_/g, " ");

/** What PayPal itself says about a real dispute, read fresh when the page was loaded. */
export function PayPalStatusCard({ live }: { live: LiveDisputeInfo }) {
  const rows: Array<[string, string]> = [
    ["PayPal dispute", live.paypalDisputeId],
    ["PayPal's reason", live.reasonCode ? `${humanise(live.reasonCode)} (${live.reasonCode})` : "not given"],
    ["PayPal status", live.status ? humanise(live.status) : "unknown"],
    ["Stage", live.stage ? humanise(live.stage) : "unknown"],
    ["Respond by", live.dueDate ? UTC(live.dueDate) : "not given"],
  ];
  return (
    <section aria-labelledby="paypal-live" className="rounded-xl border-2 border-sky-300 bg-sky-50/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="paypal-live" className="font-medium">Live PayPal dispute</h2>
        <span className="rounded-full border border-sky-300 bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900">Real, not simulated</span>
      </div>
      {live.readFailed ? (
        <p role="alert" className="mt-3 text-sm text-amber-900">{live.readFailed}</p>
      ) : (
        <>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt className="inline text-muted-foreground">{label}: </dt>
                <dd className="inline break-words font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-sm">
            <span className="text-muted-foreground">PayPal allows you to do now: </span>
            <span className="font-medium">{live.allowed.length ? live.allowed.map(actionLabel).join(", ") : "nothing this app can send"}</span>
          </p>
        </>
      )}
    </section>
  );
}
