import { StartDemoButton } from "@/components/demo/start-demo-button";

export default function DashboardPage() {
  return (
    <div className="max-w-2xl space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <section aria-labelledby="start-demo" className="space-y-3 rounded-lg border bg-card p-6">
        <div>
          <h2 id="start-demo" className="font-medium">Try the dispute desk</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Start demo gives you your own copies of the three open example disputes (a strong contest, a refund, and one with evidence gaps), with
            their evidence and analysis. Only you see them, and approving them simulates the PayPal action. Clicking again just opens your copies.
          </p>
        </div>
        <StartDemoButton />
      </section>
      <div className="rounded-lg border bg-card p-6">
        <p className="font-medium">Coming in M4</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Chargeback fees avoided, dollars protected and your recent agent activity will appear here. Orders are ready now.
        </p>
      </div>
    </div>
  );
}
