"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";

interface NavItem {
  label: string;
  href: string;
  /** Pages that land in a later milestone are shown, but not linked. */
  available: boolean;
  soon?: string;
}

const ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", available: true },
  { label: "Orders", href: "/orders", available: true },
  { label: "Disputes", href: "/disputes", available: true },
  { label: "Insights", href: "/insights", available: false, soon: "M4" },
  { label: "Agent Activity", href: "/activity", available: true },
];

export function SidebarNav() {
  const pathname = usePathname();
  const isCurrent = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {ITEMS.map((item) =>
        item.available ? (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isCurrent(item.href) ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isCurrent(item.href) ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"
            }`}
          >
            {item.label}
          </Link>
        ) : (
          <span key={item.href} aria-disabled="true" className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-muted-foreground">
            {item.label}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{`Soon \u00b7 ${item.soon}`}</span>
          </span>
        ),
      )}
      <button
        type="button"
        onClick={() => void signOut({ callbackUrl: "/login" })}
        className="mt-4 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Sign out
      </button>
    </nav>
  );
}
