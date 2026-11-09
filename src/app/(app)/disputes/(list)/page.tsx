import Link from "next/link";
import { DemoBadge } from "@/components/badges";
import { DeadlineCountdown } from "@/components/deadline-countdown";
import { StartDemoButton } from "@/components/demo/start-demo-button";
import { COL_FROM_LG } from "@/components/table-columns";
import { ToneBadge } from "@/components/tone-badge";
import { formatDate, shortId } from "@/lib/format";
import { listDisputeViews, type DisputeTab, type DisputeView } from "@/lib/disputes/read";
import { OUTCOME_LABEL, OUTCOME_TONE, REASON_LABEL, STATUS_LABEL, STATUS_TONE, money } from "@/lib/disputes/present";
import { buildReadDeps } from "@/lib/disputes/runtime";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Disputes · MoneySafe AI" };

const TABS: { key: DisputeTab; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
];

export default async function DisputesPage({ searchParams }: { searchParams: { tab?: string } }) {
  const tab: DisputeTab = searchParams.tab === "resolved" ? "resolved" : "open";
  const sessionId = await getSessionId();
  const disputes = sessionId ? await listDisputeViews(sessionId, tab, buildReadDeps()) : [];
  const renderedAt = new Date().toISOString();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Disputes</h1>
          <p className="text-sm text-muted-foreground">
            {tab === "open" ? "Soonest deadline first. Open a dispute to see the recommendation and approve an action." : "Most recently resolved first."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StartDemoButton />
          <p className="text-xs text-muted-foreground">Your own copies of the example disputes</p>
        </div>
      </div>

      <nav aria-label="Dispute tabs" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "open" ? "/disputes" : "/disputes?tab=resolved"}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px inline-flex min-h-[2.75rem] items-center rounded-t-md border-b-2 px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {disputes.length === 0 ? (
        <EmptyState tab={tab} />
      ) : tab === "open" ? (
        <OpenTable disputes={disputes} renderedAt={renderedAt} />
      ) : (
        <ResolvedTable disputes={disputes} />
      )}
    </div>
  );
}

function EmptyState({ tab }: { tab: DisputeTab }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="font-medium">{tab === "open" ? "No open disputes" : "No resolved disputes yet"}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {tab === "open" ? "When a buyer opens a dispute it appears here with its deadline." : "Disputes you resolve, and the demo history, appear here."}
      </p>
    </div>
  );
}

const th = "px-4 py-2 font-medium";
const td = "px-4 py-3 align-middle";

function OpenTable({ disputes, renderedAt }: { disputes: DisputeView[]; renderedAt: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Open disputes, soonest deadline first</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            <th scope="col" className={th}>Reason</th>
            <th scope="col" className={`${th} text-right`}>Amount</th>
            <th scope="col" className={th}>Deadline</th>
            <th scope="col" className={`${th} ${COL_FROM_LG}`}>Order</th>
            <th scope="col" className={`${th} ${COL_FROM_LG}`}>Status</th>
          </tr>
        </thead>
        <tbody>
          {disputes.map((d) => (
            <tr key={d.id} className="border-t hover:bg-muted/30">
              <td className={td}>
                <Link href={`/disputes/${d.id}`} className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {REASON_LABEL[d.reason]}
                </Link>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {d.isDemo ? <DemoBadge /> : null}
                  {d.isSharedExample ? <ToneBadge tone="neutral">Shared example</ToneBadge> : null}
                </div>
              </td>
              <td className={`${td} text-right tabular-nums`}>{money(d.amountUsd)}</td>
              <td className={td}>
                <DeadlineCountdown deadline={d.deadlineAt} renderedAt={renderedAt} />
              </td>
              <td className={`${td} font-mono ${COL_FROM_LG}`}>
                <Link href={`/orders/${d.orderId}`} className="underline-offset-2 hover:underline">{d.orderRef}</Link>
              </td>
              <td className={`${td} ${COL_FROM_LG}`}>
                <ToneBadge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</ToneBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResolvedTable({ disputes }: { disputes: DisputeView[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Resolved disputes, most recently resolved first</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            <th scope="col" className={th}>Reason</th>
            <th scope="col" className={`${th} text-right`}>Amount</th>
            <th scope="col" className={th}>Outcome</th>
            <th scope="col" className={`${th} ${COL_FROM_LG}`}>Resolved</th>
            <th scope="col" className={`${th} ${COL_FROM_LG}`}>Order</th>
          </tr>
        </thead>
        <tbody>
          {disputes.map((d) => (
            <tr key={d.id} className="border-t hover:bg-muted/30">
              <td className={td}>
                <Link href={`/disputes/${d.id}`} className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {REASON_LABEL[d.reason]}
                </Link>
                <div className="mt-1 flex flex-wrap gap-1.5">{d.isDemo ? <DemoBadge /> : null}</div>
              </td>
              <td className={`${td} text-right tabular-nums`}>{money(d.amountUsd)}</td>
              <td className={td}>
                {d.outcome ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <ToneBadge tone={OUTCOME_TONE[d.outcome]}>{OUTCOME_LABEL[d.outcome]}</ToneBadge>
                    {d.outcomeIsSimulated ? <span className="text-xs text-muted-foreground">simulated outcome</span> : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              <td className={`${td} whitespace-nowrap ${COL_FROM_LG}`}>{d.resolvedAt ? formatDate(d.resolvedAt) : "-"}</td>
              <td className={`${td} font-mono ${COL_FROM_LG}`}>
                <Link href={`/orders/${d.orderId}`} className="underline-offset-2 hover:underline">{shortId(d.orderId)}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
