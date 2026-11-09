"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DemoBadge } from "@/components/badges";
import { useToast } from "@/components/toast/toast-provider";
import { describeDelta } from "@/lib/insights/present";
import type { ProposalView } from "@/lib/insights/read";

const btn = "rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

type Notice = { tone: "ok" | "error"; text: string } | null;

/**
 * The pending weight change (REQ-LL-02): what would change, the reasoning, and Approve / Reject.
 * Nothing is applied until Approve. The page sends back the proposal it is showing, so a
 * proposal that was replaced in the meantime cannot be decided by mistake.
 */
export function WeightChangeProposal({ proposal }: { proposal: ProposalView }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const changed = proposal.changes.filter((c) => c.delta !== 0);

  async function decide(kind: "approve" | "reject") {
    setBusy(kind);
    setNotice(null);
    try {
      const response = await fetch(`/api/insights/${kind}-weights`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalCreatedAt: proposal.createdAt }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      // The card disappears once the proposal is decided, so a success has to be a toast; a failure stays on the card too.
      if (response.ok) {
        toast(
          kind === "approve"
            ? { tone: "success", title: "Weight change approved", description: "The new weights apply to orders scored from now on." }
            : { tone: "info", title: "Weight change rejected", description: "The weights are unchanged." },
        );
      } else {
        const text = body?.message ?? "Something went wrong. Please try again.";
        setNotice({ tone: "error", text });
        toast({ tone: "error", title: "The decision could not be saved", description: text });
      }
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: "We could not reach the server. Please try again." });
      toast({ tone: "error", title: "We could not reach the server", description: "Nothing was changed. Try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="proposal-heading" className="rounded-xl border-2 border-amber-300 bg-amber-50/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="proposal-heading" className="font-medium">Proposed weight change</h2>
        <span className="flex flex-wrap items-center gap-2">
          {proposal.isDemo ? <DemoBadge /> : null}
          <span className="rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900">Waiting for your approval</span>
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Proposed weights against the current ones</caption>
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">Signal</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Now</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Proposed</th>
              <th scope="col" className="py-2 pl-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {proposal.changes.map((c) => {
              const d = describeDelta(c.delta, "the current weight");
              return (
                <tr key={c.signal} className={`border-t ${c.delta === 0 ? "text-muted-foreground" : "font-medium"}`}>
                  <th scope="row" className="py-2 pr-4 text-left font-normal">{c.label}</th>
                  <td className="px-2 py-2 text-right tabular-nums">{c.current}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{c.proposed}</td>
                  <td className={`whitespace-nowrap py-2 pl-2 text-right text-xs tabular-nums sm:text-sm ${d.className}`}>
                    <span aria-hidden="true">{d.arrow} </span>
                    {d.text}
                    <span className="sr-only">, {d.spoken}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why</p>
        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{proposal.reasoning || "No reasoning was recorded."}</p>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        {changed.length === 0 ? "This proposal changes nothing." : `${changed.length} weight${changed.length === 1 ? "" : "s"} would change, by at most 3 points each.`} Weights are shared across the demo.
        Approving applies to orders scored from now on; scores already stored do not change. Rejecting discards the proposal.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={`${btn} bg-primary text-primary-foreground hover:opacity-90`} disabled={busy !== null} onClick={() => void decide("approve")}>
          {busy === "approve" ? "Approving…" : "Approve change"}
        </button>
        <button type="button" className={`${btn} border border-red-300 bg-background text-red-800 hover:bg-red-50`} disabled={busy !== null} onClick={() => void decide("reject")}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${notice.tone === "error" ? "border-red-300 bg-red-50 text-red-900" : "border-green-300 bg-green-50 text-green-900"}`}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
