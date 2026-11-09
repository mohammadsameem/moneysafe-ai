"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SimulatedBadge } from "@/components/badges";
import { StartDemoButton } from "@/components/demo/start-demo-button";
import { useToast } from "@/components/toast/toast-provider";
import { SHARED_EXAMPLE_MESSAGE } from "@/lib/demo/messages";
import type { PanelState } from "@/lib/disputes/detail";
import { money } from "@/lib/disputes/present";

const MAX_DRAFT = 2000;
const btn = "rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";
const primary = `${btn} bg-primary text-primary-foreground hover:opacity-90`;
const secondary = `${btn} border bg-background hover:bg-accent`;
const danger = `${btn} border border-red-300 bg-background text-red-800 hover:bg-red-50`;

type Notice = { tone: "ok" | "info" | "error"; text: string; retryable?: boolean } | null;

interface Props {
  disputeId: string;
  panel: PanelState;
  amountUsd: number;
  /** True when approving is simulated (Demo Mode, or a seeded / demo dispute): nothing is sent to PayPal. */
  willSimulate: boolean;
  /** Show "Simulate outcome (Won / Lost)" (REQ-DIS-11; the server re-checks). */
  canSimulateOutcome?: boolean;
}

/**
 * Approve / Edit + Approve / Reject (REQ-DIS-05). The merchant's click is the only thing that can
 * start a PayPal action; the server re-checks everything (approval gate, idempotency).
 */
export function ApprovalPanel({ disputeId, panel, amountUsd, willSimulate, canSimulateOutcome = false }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const draft = panel.mode === "decide" ? panel.draft ?? "" : "";
  const [text, setText] = useState(draft);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const edited = editing && text.trim() !== draft.trim();

  async function send(kind: "approve" | "reject", action: "submit_evidence" | "accept_claim", editedDraft?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/disputes/${disputeId}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "approve" ? { action, ...(editedDraft ? { editedDraft } : {}) } : { action }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { status?: string; message?: string; simulated?: boolean; error?: string } | null;
      // Successes are toasts (the panel re-renders into its "done" state); failures stay on screen with a Retry.
      if (response.ok && body?.status === "executed") {
        toast(
          body.simulated
            ? { tone: "success", title: "Approved (simulated)", description: "Your approval is recorded. Nothing was sent to PayPal." }
            : { tone: "success", title: "Approved and sent to PayPal" },
        );
      } else if (response.ok && body?.status === "already_executed") {
        toast({ tone: "info", title: "Action already executed", description: "It only ever runs once." });
      } else if (response.ok && body?.status === "rejected") {
        toast({ tone: "info", title: "Rejected", description: "Nothing was sent to PayPal. You can still approve it later." });
      } else if (response.status === 502) {
        const text = `PayPal did not accept the request: ${body?.message ?? "unknown error"}. Nothing was lost; you can retry safely.`;
        setNotice({ tone: "error", text, retryable: true });
        toast({ tone: "error", title: "PayPal did not accept the request", description: "Nothing was lost. Use Retry; it is safe." });
      } else {
        const text = body?.message ?? "Something went wrong. Please try again.";
        setNotice({ tone: "error", text });
        toast({ tone: "error", title: "The action could not be completed", description: text });
      }
      setConfirming(false);
      setEditing(false);
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: "We could not reach the server. Please try again.", retryable: true });
      toast({ tone: "error", title: "We could not reach the server", description: "Nothing was changed. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function recordOutcome(outcome: "won" | "lost") {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/disputes/${disputeId}/simulate-outcome`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (response.ok) {
        toast({ tone: "success", title: `Recorded: dispute ${outcome === "won" ? "won" : "lost"}`, description: "Saved as a simulated outcome. The Dashboard and Insights now include it." });
      } else {
        const text = body?.message ?? "The outcome could not be recorded.";
        setNotice({ tone: "error", text });
        toast({ tone: "error", title: "The outcome could not be recorded", description: text });
      }
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: "We could not reach the server. Please try again." });
      toast({ tone: "error", title: "We could not reach the server", description: "Nothing was changed. Try again." });
    } finally {
      setBusy(false);
    }
  }

  const banner = notice ? (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${notice.tone === "error" ? "border-red-300 bg-red-50 text-red-900" : notice.tone === "ok" ? "border-green-300 bg-green-50 text-green-900" : "border-sky-300 bg-sky-50 text-sky-900"}`}
    >
      {notice.text}
    </div>
  ) : null;

  const simulatedNote = willSimulate ? (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <SimulatedBadge /> This is demo data: approving records your decision and simulates the PayPal action. Nothing is sent to PayPal.
    </p>
  ) : null;

  return (
    <section aria-labelledby="approval" className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="approval" className="font-medium">Your decision</h2>
        <p className="text-xs text-muted-foreground">Approving twice is safe: the action only ever runs once.</p>
      </div>

      {panel.mode === "no_analysis" ? <p className="text-sm text-muted-foreground">Available once the analysis is ready.</p> : null}

      {panel.mode === "resolved" ? <p className="text-sm text-muted-foreground">This dispute is resolved. There is nothing left to approve.</p> : null}

      {panel.mode === "shared_example" ? (
        <div className="space-y-3">
          <div role="note" className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950">
            <p className="font-medium">{SHARED_EXAMPLE_MESSAGE}</p>
            <p className="mt-1 text-xs">Every visitor sees this example, so it cannot be approved or rejected. Start demo gives you your own copy with the same evidence and analysis.</p>
          </div>
          <StartDemoButton seedDisputeId={disputeId} />
        </div>
      ) : null}

      {panel.mode === "done" ? (
        <div role="status" className="space-y-2 rounded-md border border-green-300 bg-green-50 px-3 py-3 text-sm text-green-950">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            Action already executed {panel.simulated ? <SimulatedBadge /> : null}
          </p>
          <p>
            {panel.action === "submit_evidence" ? `Evidence${panel.edited ? " (with your edits)" : ""} was ${panel.simulated ? "simulated" : "sent to PayPal"}` : `The refund was ${panel.simulated ? "simulated" : "accepted with PayPal"}`} on{" "}
            {new Date(panel.executedAt).toUTCString().replace(" GMT", " UTC")}.
          </p>
        </div>
      ) : null}

      {panel.mode === "done" && panel.action === "submit_evidence" && canSimulateOutcome ? (
        <div className="space-y-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-3 text-sm text-violet-950">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            Simulate outcome <SimulatedBadge />
          </p>
          <p className="text-xs">Demo only: pick how PayPal resolved this dispute. It is recorded as a simulated outcome.</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Simulate outcome">
            <button type="button" className={primary} disabled={busy} onClick={() => void recordOutcome("won")}>
              {busy ? "Recording…" : "Won"}
            </button>
            <button type="button" className={danger} disabled={busy} onClick={() => void recordOutcome("lost")}>
              Lost
            </button>
          </div>
        </div>
      ) : null}

      {panel.mode === "retry" ? (
        <div className="space-y-3">
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            You approved this, but the last attempt to send it to PayPal did not go through. Retrying is safe: it reuses the same request, so PayPal cannot apply it twice.
          </div>
          <button type="button" className={primary} disabled={busy} onClick={() => void send("approve", panel.action)}>
            {busy ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      {panel.mode === "decide" ? (
        <div className="space-y-4">
          {panel.rejectedAt ? (
            <p className="text-sm text-muted-foreground">You rejected this on {new Date(panel.rejectedAt).toUTCString().replace(" GMT", " UTC")}. You can still approve it.</p>
          ) : null}

          {panel.action === "submit_evidence" ? (
            <div>
              <label htmlFor="draft" className="text-sm font-medium">
                Response to PayPal {editing ? <span className="font-normal text-muted-foreground">(editing)</span> : null}
              </label>
              <textarea
                id="draft"
                value={text}
                onChange={(e) => setText(e.target.value)}
                readOnly={!editing}
                maxLength={MAX_DRAFT}
                rows={10}
                aria-describedby="draft-help"
                className={`mt-1 block w-full rounded-md border px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${editing ? "bg-background" : "bg-muted/40"}`}
              />
              <p id="draft-help" className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>{editing ? "Edit the wording, then approve. The original draft is kept alongside your version." : "Review it, then approve as drafted or edit first."}</span>
                <span className="tabular-nums">{text.length} / {MAX_DRAFT}</span>
              </p>
            </div>
          ) : (
            <p className="text-sm">Accepting the claim refunds the buyer in full ({money(amountUsd)}) and closes the dispute.</p>
          )}

          {simulatedNote}

          {confirming ? (
            <div role="alert" className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950">
              <p>{panel.action === "submit_evidence" ? "This sends your response to PayPal." : `This refunds the buyer ${money(amountUsd)} through PayPal.`} Confirm?</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={primary} disabled={busy} onClick={() => void send("approve", panel.action, edited ? text.trim() : undefined)}>
                  {busy ? "Sending…" : "Yes, send it"}
                </button>
                <button type="button" className={secondary} disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primary}
                disabled={busy || (panel.action === "submit_evidence" && text.trim() === "")}
                onClick={() => (willSimulate ? void send("approve", panel.action, edited ? text.trim() : undefined) : setConfirming(true))}
              >
                {busy ? "Working…" : panel.action === "accept_claim" ? "Approve refund" : edited ? "Approve edited response" : "Approve"}
              </button>
              {panel.action === "submit_evidence" ? (
                <button
                  type="button"
                  className={secondary}
                  disabled={busy}
                  aria-pressed={editing}
                  onClick={() => {
                    if (editing) setText(draft);
                    setEditing(!editing);
                  }}
                >
                  {editing ? "Discard edits" : "Edit"}
                </button>
              ) : null}
              <button type="button" className={danger} disabled={busy} onClick={() => void send("reject", panel.action)}>
                Reject
              </button>
            </div>
          )}
        </div>
      ) : null}

      {banner}
      {notice?.retryable && panel.mode !== "retry" ? (
        <button type="button" className={secondary} disabled={busy} onClick={() => panel.mode === "decide" && void send("approve", panel.action, edited ? text.trim() : undefined)}>
          Retry
        </button>
      ) : null}
    </section>
  );
}
