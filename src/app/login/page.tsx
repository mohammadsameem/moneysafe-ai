import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { DEMO_LOGIN_EMAIL, authOptions } from "@/lib/auth";

export const metadata = { title: "Sign in · MoneySafe AI" };

export default async function LoginPage() {
  const session = await getServerSession(authOptions);
  if (session?.sid) redirect("/orders");

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">MoneySafe AI</h1>
          <p className="text-sm text-muted-foreground">The risk desk for micro-merchants.</p>
        </div>
        <LoginForm demoEmail={DEMO_LOGIN_EMAIL} />
        <p className="text-center text-xs text-muted-foreground">
          This is a public demo. Use the demo email above; the password is in the project README.
        </p>
      </div>
    </main>
  );
}
