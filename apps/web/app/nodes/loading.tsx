function NodeRowSkeleton() {
  return (
    <tr className="border-b border-border/60">
      <td className="py-3 pr-4">
        <div className="skeleton h-4 w-40" />
      </td>
      <td className="py-3 pr-4">
        <div className="skeleton h-5 w-28" />
      </td>
      <td className="py-3 pr-4">
        <div className="skeleton h-4 w-24" />
      </td>
      <td className="py-3 pr-4">
        <div className="skeleton h-4 w-8" />
      </td>
      <td className="py-3 pr-4">
        <div className="skeleton h-4 w-24" />
      </td>
    </tr>
  );
}

export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <span className="sr-only" role="status">
        Loading the reporting node roster…
      </span>
      <div aria-hidden="true">
        <div className="skeleton h-10 w-64" />
        <div className="skeleton mt-3 h-4 w-96" />

        <div className="card mt-8 flex flex-wrap gap-x-8 gap-y-3 p-4">
          <div className="skeleton h-8 w-16" />
          <div className="skeleton h-8 w-16" />
          <div className="skeleton h-8 w-24" />
        </div>

        <div className="skeleton mt-8 h-4 w-full max-w-2xl" />

        <div className="mt-4 table-scroll">
          <table className="min-w-[720px] text-sm">
            <tbody>
              {Array.from({ length: 4 }).map((_, i) => (
                <NodeRowSkeleton key={i} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
