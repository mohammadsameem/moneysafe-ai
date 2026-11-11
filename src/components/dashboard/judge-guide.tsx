import Link from "next/link";
import { StartDemoButton } from "@/components/demo/start-demo-button";

const link = "font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A five-step path through the demo for someone seeing it for the first time. */
export function JudgeGuide() {
  return (
    <section aria-labelledby="judge-guide" className="rounded-xl border-2 border-violet-300 bg-violet-50/40 p-5">
      <h2 id="judge-guide" className="font-medium">Judge guide: try it in five steps</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
        <li>
          <Link href="/orders" className={link}>See Orders</Link>: each risk score lists the explainable signals that fired. SEED-B ($210) is &ldquo;Verify first&rdquo;, SEED-F ($320) is &ldquo;Hold&rdquo;.
        </li>
        <li>
          <strong>Start demo</strong> (the button below): you get your own copies of the three open example disputes, ready to use.
        </li>
        <li>
          Open your SEED-C copy (Item not received, $145) in <Link href="/disputes" className={link}>Disputes</Link> and approve it. The action is simulated; nothing is sent to PayPal.
        </li>
        <li>
          On that dispute choose <strong>Simulate outcome</strong>, then Won. It is recorded as a simulated outcome.
        </li>
        <li>
          See <Link href="/insights" className={link}>Insights</Link> and this Dashboard update: Dollars protected, the outcome chart and the summary.
        </li>
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <StartDemoButton />
        <p className="text-xs text-muted-foreground">Safe to click again: it just opens your existing copies.</p>
      </div>
    </section>
  );
}
