import type { EvidenceArtefact } from "@/db/schema";

const TYPE_LABEL: Record<EvidenceArtefact["artefactType"], string> = {
  invoice_summary: "Invoice / order summary",
  line_items: "Order line items",
  buyer_contact: "Buyer contact details",
  tracking_info: "Tracking number + carrier",
  tracking_events: "Carrier scan events",
  buyer_communication: "Buyer communication",
};
const SOURCE_LABEL: Record<EvidenceArtefact["source"], string> = {
  paypal_api: "PayPal",
  merchant_input: "Merchant input",
  tracking_api: "Carrier tracking",
  mocked: "Mocked",
  seed: "Demo data",
};

const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(iso)) + " UTC";

function MockedBadge() {
  return <span className="rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-900" title="Not from a real carrier">Mocked</span>;
}

interface ScanEvent {
  timestamp?: unknown;
  status?: unknown;
  location?: unknown;
  isMocked?: unknown;
}

function scanEvents(payload: unknown): ScanEvent[] {
  const events = (payload as { events?: unknown } | null)?.events;
  return Array.isArray(events) ? (events as ScanEvent[]) : [];
}

/** Every stored artefact, newest last, each expandable to its exact stored payload. */
export function ArtefactList({ artefacts }: { artefacts: EvidenceArtefact[] }) {
  return (
    <ul className="space-y-2">
      {artefacts.map((a) => {
        const events = a.artefactType === "tracking_events" ? scanEvents(a.payload) : [];
        return (
          <li key={a.id}>
            <details className="group rounded-lg border">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="font-medium">{TYPE_LABEL[a.artefactType]}</span>
                <span className="text-xs text-muted-foreground">{SOURCE_LABEL[a.source]}</span>
                {a.isMocked ? <MockedBadge /> : null}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{when(a.createdAt)}</span>
              </summary>
              <div className="space-y-2 border-t px-3 py-3">
                {events.length > 0 ? (
                  <ol className="space-y-1 text-sm">
                    {events.map((e, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-2">
                        <span className={`font-medium ${e.status === "Delivered" ? "text-green-800" : ""}`}>{String(e.status ?? "")}</span>
                        <span className="text-muted-foreground">{String(e.location ?? "")}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{typeof e.timestamp === "string" ? when(e.timestamp) : ""}</span>
                        {e.isMocked === true ? <MockedBadge /> : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
                <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-xs leading-relaxed">{JSON.stringify(a.payload, null, 2)}</pre>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
