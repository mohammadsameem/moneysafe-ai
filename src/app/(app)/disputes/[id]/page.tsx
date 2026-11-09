import Link from "next/link";
import { notFound } from "next/navigation";
import { DemoBadge } from "@/components/badges";
import { DeadlineCountdown } from "@/components/deadline-countdown";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { listActivity } from "@/lib/activity/queries";
import { AnalysisTrigger } from "@/components/disputes/analysis-trigger";
import { ApprovalPanel } from "@/components/disputes/approval-panel";
import { DisputeTimeline } from "@/components/disputes/dispute-timeline";
import { EvidenceChips } from "@/components/disputes/evidence-chips";
import { RecommendationCard } from "@/components/disputes/recommendation-card";
import { WinLikelihoodMeter } from "@/components/disputes/win-likelihood-meter";
import { ToneBadge } from "@/components/tone-badge";
import { shortId } from "@/lib/format";
import { loadDisputeDetail } from "@/lib/disputes/detail";
import { OUTCOME_LABEL, OUTCOME_TONE, REASON_LABEL, STATUS_LABEL, STATUS_TONE, money } from "@/lib/disputes/present";
import { isResolvedStatus } from "@/lib/disputes/read";
import { buildDetailDeps } from "@/lib/disputes/runtime";
import { buildTimeline } from "@/lib/disputes/timeline";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dispute · MoneySafe AI" };

export default async function DisputeDetailPage({ params }: { params: { id: string } }) {
  const sessionId = await getSessionId();
  const detail = sessionId ? await loadDisputeDetail(params.id, sessionId, buildDetailDeps()) : null;
  if (!detail) notFound();
  const { view, panel, willSimulate, renderedAt } = detail;
  const timeline = buildTimeline(detail);
  const activity = await listActivity(sessionId!, { refDisputeId: view.id, pageSize: 10 });
  const analysis = view.analysis;
  const resolved = isResolvedStatus(view.status);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-3">
        <Link href={resolved ? "/disputes?tab=resolved" : "/disputes"} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          ← Disputes
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{REASON_LABEL[view.reason]}</h1>
          <span className="text-2xl font-semibold tabular-nums text-muted-foreground">{money(view.amountUsd)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resolved && view.outcome ? (
            <ToneBadge tone={OUTCOME_TONE[view.outcome]}>
              {OUTCOME_LABEL[view.outcome]}
              {view.outcomeIsSimulated ? " (simulated outcome)" : ""}
            </ToneBadge>
          ) : (
            <>
              <DeadlineCountdown deadline={view.deadlineAt} renderedAt={renderedAt} />
              <ToneBadge tone={STATUS_TONE[view.status]}>{STATUS_LABEL[view.status]}</ToneBadge>
            </>
          )}
          {view.isDemo ? <DemoBadge /> : null}
          <Link href={`/orders/${view.orderId}`} className="text-sm underline-offset-2 hover:underline">
            Order <span className="font-mono">{shortId(view.orderId)}</span>
          </Link>
        </div>
        {view.buyerMessage ? (
          <blockquote className="rounded-lg border-l-4 border-muted-foreground/30 bg-muted/40 px-4 py-3 text-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Buyer&apos;s message</p>
            <p className="mt-1 whitespace-pre-line">{view.buyerMessage}</p>
          </blockquote>
        ) : null}
      </header>

      {analysis === null ? (
        resolved ? (
          <p className="text-sm text-muted-foreground">This dispute was resolved without an analysis on file.</p>
        ) : (
          <AnalysisTrigger disputeId={view.id} />
        )
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            <RecommendationCard analysis={analysis} />
            <EvidenceChips used={analysis.evidenceUsed} gaps={analysis.evidenceGaps} />
          </div>
          <div className="space-y-6 lg:col-span-2">
            {analysis.winProbability !== null && analysis.winLikelihoodLabel !== null ? (
              <WinLikelihoodMeter probability={analysis.winProbability} label={analysis.winLikelihoodLabel} llmAdjustment={analysis.llmAdjustment} />
            ) : null}
          </div>
          <div className="lg:col-span-3">
            <ApprovalPanel disputeId={view.id} panel={panel} amountUsd={view.amountUsd} willSimulate={willSimulate} />
          </div>
          <div className="lg:col-span-2">
            <DisputeTimeline steps={timeline} />
          </div>
        </div>
      )}
      {analysis === null ? <DisputeTimeline steps={timeline} /> : null}
      <ActivityFeed initial={activity} refDisputeId={view.id} title="Activity for this dispute" />
    </div>
  );
}
