import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { BottomNav, MobileHeader, SidebarNav } from "@/components/app-nav";
import { ToastProvider } from "@/components/toast/toast-provider";
import { authOptions } from "@/lib/auth";

/**
 * Every page in this group needs a signed-in session (REQ-AUTH-01). The check is on the server, so
 * a signed-out visitor is redirected before any page content or data is produced.
 *
 * Layout: from 768 px up, a sidebar on the left. Below that, a slim top bar (name + Sign out) and a
 * five-tab bar fixed to the bottom, with room left under the content so nothing hides behind it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.sid) redirect("/login");

  return (
    <ToastProvider>
      <div className="min-h-screen md:flex">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring">
          Skip to content
        </a>
        <MobileHeader />
        <aside className="hidden border-r bg-card p-4 md:sticky md:top-0 md:block md:h-screen md:w-64 md:shrink-0 md:overflow-y-auto">
          <div className="mb-6 px-3">
            <p className="text-lg font-semibold tracking-tight">MoneySafe AI</p>
            <p className="text-xs text-muted-foreground">The risk desk for micro-merchants.</p>
          </div>
          <SidebarNav />
        </aside>
        <main id="main" className="min-w-0 flex-1 p-4 pb-24 md:p-8 md:pb-8">
          {children}
        </main>
        <BottomNav />
      </div>
    </ToastProvider>
  );
}
