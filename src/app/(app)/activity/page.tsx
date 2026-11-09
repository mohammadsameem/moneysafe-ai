import { ActivityFeed } from "@/components/activity/activity-feed";
import { listActivity } from "@/lib/activity/queries";
import { getSessionId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent Activity · MoneySafe AI" };

export default async function ActivityPage() {
  const sessionId = await getSessionId();
  const initial = sessionId ? await listActivity(sessionId) : { entries: [], page: 1, pageSize: 20, hasMore: false };
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent Activity</h1>
        <p className="text-sm text-muted-foreground">Every step the agent took: PayPal calls, AI calls, rule checks and your decisions. Personal details are removed from the summaries.</p>
      </div>
      <ActivityFeed initial={initial} full title="All activity" />
    </div>
  );
}
