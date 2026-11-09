"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { OrderSummary } from "@/lib/orders/queries";
import { formatDate, formatUsd, shortId, sortOrders, type SortDirection, type SortKey } from "@/lib/format";
import { DemoBadge, RiskBadge } from "./badges";
import { COL_FROM_LG, COL_FROM_XL } from "./table-columns";

/** `hide: "sm"` = Buyer (back at 1024 px), `hide: "md"` = Date (back at 1280 px); see table-columns.ts. Risk is never hidden. */
const COLUMNS: { key: SortKey; label: string; align?: "right"; hide?: "sm" | "md" }[] = [
  { key: "id", label: "Order" },
  { key: "buyer", label: "Buyer", hide: "sm" },
  { key: "amount", label: "Amount", align: "right" },
  { key: "date", label: "Date", hide: "md" },
  { key: "risk", label: "Risk" },
];
const HIDE: Record<"sm" | "md", string> = { sm: COL_FROM_LG, md: COL_FROM_XL };

export function OrdersTable({ orders }: { orders: OrderSummary[] }) {
  const [key, setKey] = useState<SortKey>("date");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const rows = useMemo(() => sortOrders(orders, key, direction), [orders, key, direction]);

  if (orders.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="font-medium">No orders yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Create a sandbox order above, or run the seed script to load the sample orders.</p>
      </div>
    );
  }

  function toggle(next: SortKey) {
    if (next === key) setDirection(direction === "asc" ? "desc" : "asc");
    else {
      setKey(next);
      setDirection(next === "amount" || next === "risk" || next === "date" ? "desc" : "asc");
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Orders. Use the column buttons to sort.</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={key === c.key ? (direction === "asc" ? "ascending" : "descending") : "none"}
                className={`px-3 py-2 font-medium sm:px-4 ${c.align === "right" ? "text-right" : ""} ${c.hide ? HIDE[c.hide] : ""}`}
              >
                <button
                  type="button"
                  data-compact
                  onClick={() => toggle(c.key)}
                  className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {c.label}
                  <span aria-hidden="true" className="text-xs text-muted-foreground">{key === c.key ? (direction === "asc" ? "▲" : "▼") : ""}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className="border-t hover:bg-muted/30">
              <td className="px-3 py-2 font-mono sm:px-4">
                <Link href={`/orders/${o.id}`} className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {shortId(o.id)}
                </Link>
              </td>
              <td className={`px-4 py-2 ${HIDE.sm}`}>{o.buyerEmail}</td>
              <td className="px-3 py-2 text-right tabular-nums sm:px-4">{formatUsd(o.amountUsd, o.currency)}</td>
              <td className={`whitespace-nowrap px-4 py-2 ${HIDE.md}`}>{formatDate(o.createdAt)}</td>
              <td className="px-3 py-2 sm:px-4">
                <div className="flex flex-wrap items-center gap-2">
                  <RiskBadge verdict={o.verdict} score={o.riskScore} />
                  {o.isDemo ? <DemoBadge /> : null}
                  {o.status !== "captured" && o.status !== "shipped" ? (
                    <span className="text-xs text-muted-foreground">{o.status === "created" ? "Awaiting payment" : "Cancelled"}</span>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
