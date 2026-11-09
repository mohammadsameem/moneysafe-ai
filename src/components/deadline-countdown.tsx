"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/disputes/deadline";

/**
 * Live time left until a dispute deadline (REQ-DIS-02): red under 48 hours, refreshed every 30 s.
 * The server renders the first value; the browser keeps it current.
 */
export function DeadlineCountdown({ deadline, renderedAt }: { deadline: string; renderedAt: string }) {
  const [now, setNow] = useState(() => new Date(renderedAt));

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const c = formatCountdown(deadline, now);
  const tone = c.urgent ? "border-red-300 bg-red-50 text-red-900" : "border-border bg-muted text-foreground";
  const label = c.overdue ? "Deadline passed" : c.text === "Unknown" ? "Deadline unknown" : `${c.text} left`;

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${tone}`}
      title={`Deadline: ${new Date(deadline).toUTCString()}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${c.urgent ? "bg-red-600" : "bg-muted-foreground"}`} />
      <span suppressHydrationWarning>{label}</span>
      {c.urgent && !c.overdue ? <span className="sr-only">, urgent: under 48 hours</span> : null}
    </span>
  );
}
