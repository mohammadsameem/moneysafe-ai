import type { EvidenceArtefact } from "@/db/schema";
import type { CompletenessItem } from "@/lib/scoring";
import { ArtefactList } from "./artefact-list";
import { EvidenceCompleteness } from "./evidence-completeness";
import { LogMessageForm } from "./log-message-form";
import { ShipOrderButton } from "./ship-order-button";
import { SimulateDisputeButton } from "./simulate-dispute-button";

interface Props {
  orderId: string;
  status: "created" | "captured" | "shipped" | "cancelled";
  /** The session's own (non-seed) order: it can be shipped and messages can be logged. */
  owned: boolean;
  /** "Simulate dispute" is a demo tool (REQ-DU-02): shown for seeded and demo orders and in Demo Mode. */
  canSimulateDispute: boolean;
  completeness: number;
  breakdown: CompletenessItem[];
  artefacts: EvidenceArtefact[];
}

export function EvidenceVault({ orderId, status, owned, canSimulateDispute, completeness, breakdown, artefacts }: Props) {
  const shipped = status === "shipped";
  return (
    <section aria-labelledby="vault" className="space-y-5 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="vault" className="font-medium">Evidence Vault</h2>
          <p className="text-sm text-muted-foreground">Everything on file to defend this order in a dispute. Stored evidence is never edited or deleted.</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {owned && status === "captured" ? <ShipOrderButton orderId={orderId} /> : null}
          {shipped && canSimulateDispute ? <SimulateDisputeButton orderId={orderId} /> : null}
        </div>
      </div>

      {!shipped && artefacts.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          Not shipped yet. {owned && status === "captured" ? "Mark the order as shipped to assemble its evidence." : status === "captured" ? "This is a shared example order, so it cannot be shipped here." : ""}
        </p>
      ) : (
        <>
          <EvidenceCompleteness score={completeness} breakdown={breakdown} />
          <ArtefactList artefacts={artefacts} />
        </>
      )}

      {owned && shipped ? <LogMessageForm orderId={orderId} /> : null}
    </section>
  );
}
