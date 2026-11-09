import { SectionSkeleton, Skeleton } from "@/components/ui/states";

/** Agent Activity loading skeleton (REQ-NFR-07). */
export default function ActivityLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-4" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <SectionSkeleton what="agent activity" rows={6} />
    </div>
  );
}
