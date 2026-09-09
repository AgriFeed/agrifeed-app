export function TickerRowSkeleton() {
  return (
    <div className="ticker-row flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex items-baseline justify-between gap-4 sm:justify-start sm:gap-3">
        <div className="skeleton h-4 w-16" />
        <div className="skeleton h-5 w-32" />
      </div>
      <div className="flex items-center gap-4 sm:ml-auto">
        <div className="skeleton h-3 w-4" />
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-3 w-20" />
      </div>
    </div>
  );
}
