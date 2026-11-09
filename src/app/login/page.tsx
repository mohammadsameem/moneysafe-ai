import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { DEMO_LOGIN_EMAIL, authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic"; // reads DEMO_PASSWORD at request time, not at build time
export const metadata = { title: "Sign in · MoneySafe AI" };

export default async function LoginPage() {
  const session = await getServerSession(authOptions);
  if (session?.sid) redirect("/orders");

  // Public by design (REQ-AUTH-02): this is a shared demo account with sample data only.
  const demoPassword = process.env.DEMO_PASSWORD?.trim() || null;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">MoneySafe AI</h1>
          <p className="text-sm text-muted-foreground">The risk desk for micro-merchants.</p>
        </div>

        <section aria-labelledby="demo-login" className="rounded-lg border border-violet-300 bg-violet-50 p-4 text-violet-950">
          <h2 id="demo-login" className="text-sm font-semibold">Demo login</h2>
          <p className="mt-1 text-xs">Public demo credentials for this sample account. It holds sample data only.</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="font-medium">Email</dt>
            <dd className="break-all font-mono">{DEMO_LOGIN_EMAIL}</dd>
            <dt className="font-medium">Password</dt>
            <dd className="break-all font-mono">{demoPassword ?? "not configured on this server"}</dd>
          </dl>
        </section>

        <LoginForm demoEmail={DEMO_LOGIN_EMAIL} />
      </div>
    </main>
  );
}
