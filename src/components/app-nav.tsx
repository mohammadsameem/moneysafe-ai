"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { NAV_ITEMS, isCurrentPath, type NavIconName } from "@/lib/nav";

const PATHS: Record<NavIconName, string> = {
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  orders: "M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  disputes: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 8v4M12 16h.01",
  insights: "M4 20V10M10 20V4M16 20v-8M2 20h20",
  activity: "M3 12h4l3-8 4 16 3-8h4",
};

function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const signOutNow = () => void signOut({ callbackUrl: "/login" });

/** Desktop navigation (md and up): a vertical list in the sidebar. */
export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const current = isCurrentPath(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${ring} ${current ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent"}`}
          >
            <NavIcon name={item.icon} />
            {item.label}
          </Link>
        );
      })}
      <button type="button" onClick={signOutNow} className={`mt-4 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent ${ring}`}>
        Sign out
      </button>
    </nav>
  );
}

/** Mobile navigation (below md): five tabs fixed to the bottom edge, thumb height, labels always shown. */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="grid grid-cols-5">
        {NAV_ITEMS.map((item) => {
          const current = isCurrentPath(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                aria-label={item.label}
                className={`flex min-h-[3.5rem] flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium ${ring} ${current ? "text-primary" : "text-muted-foreground"}`}
              >
                <NavIcon name={item.icon} />
                <span aria-hidden="true">{item.shortLabel}</span>
                {current ? <span aria-hidden="true" className="h-0.5 w-6 rounded-full bg-primary" /> : <span aria-hidden="true" className="h-0.5 w-6" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Mobile top bar (below md): the product name and Sign out. The rest of the navigation is the bottom bar. */
export function MobileHeader() {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-card px-4 py-3 md:hidden">
      <div className="min-w-0">
        <p className="truncate text-base font-semibold tracking-tight">MoneySafe AI</p>
        <p className="truncate text-[11px] text-muted-foreground">The risk desk for micro-merchants.</p>
      </div>
      <button type="button" onClick={signOutNow} className={`ml-3 min-h-[2.75rem] shrink-0 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent ${ring}`}>
        Sign out
      </button>
    </header>
  );
}
