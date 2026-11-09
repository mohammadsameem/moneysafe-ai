import Link from "next/link";

/** A record that does not exist, or is not yours to see (the two look the same on purpose). */
export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-xl border border-dashed p-8 text-center">
        <h1 className="text-xl font-semibold">We could not find that</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been removed (for example by a reset), or it belongs to another session. Your own orders and disputes are listed below.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3 text-sm font-medium">
          <Link href="/" className="rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Dashboard
          </Link>
          <Link href="/orders" className="rounded-md border px-4 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Orders
          </Link>
          <Link href="/disputes" className="rounded-md border px-4 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Disputes
          </Link>
        </div>
      </div>
    </div>
  );
}
