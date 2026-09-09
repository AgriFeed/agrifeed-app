import { TickerRowSkeleton } from "@/components/TickerRowSkeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <span className="sr-only" role="status">
        Loading commodity prices…
      </span>
      <div className="skeleton h-10 w-48" aria-hidden="true" />
      <div className="skeleton mt-3 h-4 w-96" aria-hidden="true" />
      <div className="mt-8 flex flex-col gap-px" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <TickerRowSkeleton key={i} />
        ))}
      </div>
    </main>
  );
}
