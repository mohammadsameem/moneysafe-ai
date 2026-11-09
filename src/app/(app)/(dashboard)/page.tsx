import Link from "next/link";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { JudgeGuide } from "@/components/dashboard/judge-guide";
import { MetricCard } from "@/components/dashboard/metric-card";
import { RiskDonut } from "@/components/dashboard/risk-donut";
import { SectionBoundary } from "@/components/section-boundary";
import { ResetDemoButton } from "@/components/demo/reset-demo-button";
import { RestartDemoButton } from "@/components/demo/restart-demo-button";
import { loadDashboard } from "@/lib/dashboard/load";
import { money } from "@/lib/disputes/present";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · MoneySafe AI" };

export default async function DashboardPage() {
  const sessionId = await getSessionId();
  const view = sessionId ? await loadDashboard(sessionId) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-xs text-muted-foreground">Figures cover your own activity in this session plus the shared demo history.</p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <RestartDemoButton />
          <ResetDemoButton />
        </div>
      </header>

      <JudgeGuide />

      {view ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Value under review"
              value={money(view.value_under_review.amountUsd)}
              detail={`${view.value_under_review.orderCount} order${view.value_under_review.orderCount === 1 ? "" : "s"} on Hold. Exposure, not a confirmed loss.`}
              demo={view.value_under_review.includesDemoData}
            />
            <MetricCard
              label="Disputes won"
              value={String(view.disputes_won.count)}
              detail={`${money(view.disputes_won.amountUsd)} disputed across the disputes you won through the contest path.`}
              demo={view.disputes_won.includesDemoData}
            />
            <MetricCard
              label="Chargeback fees avoided"
              value={money(view.chargeback_fees_avoided.amountUsd)}
              detail={`${view.chargeback_fees_avoided.count} accepted refund${view.chargeback_fees_avoided.count === 1 ? "" : "s"} \u00d7 ${money(view.chargeback_fees_avoided.feeUsd)} fee. Fees only; never added to Dollars protected.`}
              demo={view.chargeback_fees_avoided.includesDemoData}
            />
            <MetricCard
              label="Dollars protected"
              value={money(view.dollars_protected.amountUsd)}
              highlight={view.dollars_protected_simulated.amountUsd > 0 ? `${money(view.dollars_protected_simulated.amountUsd)} from simulated outcomes` : undefined}
              detail="Disputed amounts of won disputes only."
              demo={view.dollars_protected.includesDemoData}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <RiskDonut distribution={view.verdict_distribution} />
            <div className="space-y-2">
              <SectionBoundary what="activity feed">
                <ActivityFeed initial={{ entries: view.recent_activity, page: 1, pageSize: view.recent_activity.length || 5, hasMore: false }} title="Recent agent activity" />
              </SectionBoundary>
              <p className="text-right text-sm">
                <Link href="/activity" className="font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  View all activity
                </Link>
              </p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
