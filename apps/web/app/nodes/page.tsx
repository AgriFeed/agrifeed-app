import { getNodes, IndexerUnavailableError } from "@/lib/api";
import { SourceUnavailable } from "@/components/SourceUnavailable";
import { truncateAddress } from "@/lib/address";
import { formatTimestamp, relativeAge } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function NodesPage() {
  let nodes;
  try {
    nodes = await getNodes();
  } catch (err) {
    if (err instanceof IndexerUnavailableError) {
      return (
        <main className="mx-auto max-w-6xl px-6 py-12">
          <Header />
          <div className="mt-8">
            <SourceUnavailable what="The node list" />
          </div>
        </main>
      );
    }
    throw err;
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header />

      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-ink-muted">
              <th className="py-2 pr-4 font-normal">Address</th>
              <th className="py-2 pr-4 font-normal">Status</th>
              <th className="py-2 pr-4 font-normal">Submissions</th>
              <th className="py-2 pr-4 font-normal">Last submission</th>
              <th className="py-2 pr-4 font-normal">Added</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {nodes.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-ink-muted">
                  no nodes indexed yet. This list is only ever built from real add_node /
                  remove_node events, never seeded.
                </td>
              </tr>
            ) : (
              nodes.map((node) => (
                <tr key={node.address} className="border-b border-border/60">
                  <td className="py-2 pr-4 text-ink-primary">{truncateAddress(node.address)}</td>
                  <td className={`py-2 pr-4 ${node.active ? "text-price-up" : "text-ink-muted"}`}>
                    {node.active ? "active" : "removed"}
                  </td>
                  <td className="py-2 pr-4 text-ink-primary">{node.submissionCount}</td>
                  <td className="py-2 pr-4 text-ink-muted">
                    {node.lastSubmissionAt ? relativeAge(node.lastSubmissionAt) : "never"}
                  </td>
                  <td className="py-2 pr-4 text-ink-muted">{formatTimestamp(node.addedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Header() {
  return (
    <div>
      <h1 className="font-display text-4xl text-ink-primary">Nodes</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Every address below has been authorized on-chain via add_node. Submission counts and
        last-seen times come from real submit_price calls, this is the decentralization claim
        made checkable, not decorative.
      </p>
    </div>
  );
}
