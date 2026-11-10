import { NewOrderForm } from "@/components/new-order-form";
import { ScoringLabel } from "@/components/scoring-label";
import { OrdersTable } from "@/components/orders-table";
import { createDrizzleReadRepo, toOrderSummary } from "@/lib/orders/queries";
import { ORDER_NOTICES, isOrderNoticeKey } from "@/lib/orders/notices";
import { getSessionId } from "@/lib/session";
import { seedOrderLabels } from "@/seed/labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders · MoneySafe AI" };

export default async function OrdersPage({ searchParams }: { searchParams: { notice?: string } }) {
  const sessionId = await getSessionId();
  const rows = sessionId ? await createDrizzleReadRepo().listVisible(sessionId) : [];
  // Only a known key selects a message; anything else in the URL is ignored.
  const notice = isOrderNoticeKey(searchParams.notice) ? ORDER_NOTICES[searchParams.notice] : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <ScoringLabel />
      </div>
      {notice ? (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">{notice}</p>
      ) : null}
      <NewOrderForm />
      <OrdersTable orders={rows.map(toOrderSummary)} seedLabels={seedOrderLabels(rows.filter((r) => r.isSeed).map((r) => r.id))} />
    </div>
  );
}
