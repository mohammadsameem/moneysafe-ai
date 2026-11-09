/** The app's navigation, shared by the desktop sidebar and the mobile bottom bar. Pure. */

export type NavIconName = "dashboard" | "orders" | "disputes" | "insights" | "activity";

export interface NavItem {
  label: string;
  /** A shorter label for the mobile bottom bar, where five items share 375 px. */
  shortLabel: string;
  href: string;
  icon: NavIconName;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", shortLabel: "Dashboard", href: "/", icon: "dashboard" },
  { label: "Orders", shortLabel: "Orders", href: "/orders", icon: "orders" },
  { label: "Disputes", shortLabel: "Disputes", href: "/disputes", icon: "disputes" },
  { label: "Insights", shortLabel: "Insights", href: "/insights", icon: "insights" },
  { label: "Agent Activity", shortLabel: "Activity", href: "/activity", icon: "activity" },
];

/** True when `pathname` is the page `href` or one of its sub-pages. The dashboard (/) matches only itself. */
export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
