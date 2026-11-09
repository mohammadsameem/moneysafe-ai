import { ActivityFeed } from "@/components/activity/activity-feed";
import { SectionBoundary } from "@/components/section-boundary";
import { SectionSkeleton } from "@/components/ui/states";
import { listActivity } from "@/lib/activity/queries";

interface Props {
  sessionId: string;
  refOrderId?: string;
  refDisputeId?: string;
  title: string;
}

/**
 * The activity feed for one record, loaded after the page's main content so the page streams in
 * (wrap it in <Suspense fallback={<ActivitySkeleton />}>). The record itself was already loaded, so
 * a missing record still gives a real 404 before anything is sent.
 */
export async function ActivitySection({ sessionId, refOrderId, refDisputeId, title }: Props) {
  const initial = await listActivity(sessionId, { ...(refOrderId ? { refOrderId } : {}), ...(refDisputeId ? { refDisputeId } : {}), pageSize: 10 });
  return (
    <SectionBoundary what="activity feed">
      <ActivityFeed initial={initial} {...(refOrderId ? { refOrderId } : {})} {...(refDisputeId ? { refDisputeId } : {})} title={title} />
    </SectionBoundary>
  );
}

export function ActivitySkeleton() {
  return <SectionSkeleton what="agent activity" rows={3} />;
}
