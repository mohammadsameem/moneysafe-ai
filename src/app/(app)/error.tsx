"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ErrorCard } from "@/components/ui/error-card";

/**
 * Route-level error boundary for every page in the signed-in app. The navigation stays (this lives
 * inside the layout); only the page content is replaced by the error card. Try again re-fetches the
 * page's data and re-renders it.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="mx-auto max-w-2xl py-6">
      <ErrorCard
        error={error}
        retrying={pending}
        onRetry={() =>
          startTransition(() => {
            router.refresh();
            reset();
          })
        }
      />
    </div>
  );
}
