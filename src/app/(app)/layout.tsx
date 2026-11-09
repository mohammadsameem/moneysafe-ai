import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { SidebarNav } from "@/components/sidebar-nav";
import { ToastProvider } from "@/components/toast/toast-provider";
import { authOptions } from "@/lib/auth";

/**
 * Every page in this group needs a signed-in session (REQ-AUTH-01). The check is on the server, so
 * a signed-out visitor is redirected before any page content or data is produced.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.sid) redirect("/login");

  return (
    <ToastProvider>
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring">
        Skip to content
      </a>
      <aside className="border-b bg-card p-4 md:min-h-screen md:w-64 md:shrink-0 md:border-b-0 md:border-r">
        <div className="mb-6 px-3">
          <p className="text-lg font-semibold tracking-tight">MoneySafe AI</p>
          <p className="text-xs text-muted-foreground">The risk desk for micro-merchants.</p>
        </div>
        <SidebarNav />
      </aside>
      <main id="main" className="min-w-0 flex-1 p-4 md:p-8">
        {children}
      </main>
    </div>
    </ToastProvider>
  );
}
