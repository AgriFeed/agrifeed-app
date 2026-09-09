import Link from "next/link";
import { getNodes, IndexerUnavailableError, type OracleNode } from "@/lib/api";
import { SourceUnavailable } from "@/components/SourceUnavailable";
import { EmptyState } from "@/components/EmptyState";
import { StaleBanner } from "@/components/StaleBanner";
import { StatusBadge } from "@/components/StatusBadge";
import { IdentifierDisplay } from "@/components/IdentifierDisplay";
import { Freshness } from "@/components/Freshness";

export const dynamic = "force-dynamic";

// Mirrors the same conservative default used on Markets/Commodity Detail —
// see TickerRow.tsx's comment for why this isn't derived from a precise
// per-field expectation the current API doesn't expose.
const STALE_AFTER_SECONDS = 2 * 60 * 60;

function mostRecentActivity(nodes: OracleNode[]): string | null {
  const timestamps = nodes.flatMap((n) => [n.addedAt, n.removedAt, n.lastSubmissionAt].filter((t): t is string => t !== null));
  if (timestamps.length === 0) return null;
  return timestamps.reduce((latest, t) => (new Date(t) > new Date(latest) ? t : latest));
}

export default async function NodesPage() {
  let nodes: OracleNode[];
  try {
    nodes = await getNodes();
  } catch (err) {
    if (err instanceof IndexerUnavailableError) {
      return (
        <main className="mx-auto max-w-6xl px-6 py-12">
          <Header />
          <div className="mt-8">
            <SourceUnavailable what="The reporting node roster" />
          </div>
        </main>
      );
    }
    throw err;
  }

  const authorized = nodes.filter((n) => n.active);
  const totalSubmissions = nodes.reduce((sum, n) => sum + n.submissionCount, 0);
  const lastActivity = mostRecentActivity(nodes);
  const stale =
    lastActivity !== null && (Date.now() - new Date(lastActivity).getTime()) / 1000 > STALE_AFTER_SECONDS;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <Header />

      {nodes.length === 0 ? (
        <div className="mt-8">
          <EmptyState>
            The AgriFeedOracle contract currently has no authorized reporting nodes. This list is
            only ever built from real add_node events, never seeded.
          </EmptyState>
        </div>
      ) : (
        <>
          <Summary
            authorizedCount={authorized.length}
            totalSubmissions={totalSubmissions}
            lastActivity={lastActivity}
            stale={stale}
          />

          {stale && (
            <div className="mt-4">
              <StaleBanner>
                Recorded activity below is older than expected. The indexer may be behind — the
                roster itself is still the last real state recorded, not a placeholder.
              </StaleBanner>
            </div>
          )}

          <p className="mt-8 max-w-2xl text-sm text-ink-muted">
            <strong className="text-ink-primary">Active</strong> means the account remains
            authorized on-chain. It does not indicate current availability, submission frequency,
            or that the account is independently operated.
          </p>

          <div className="mt-4 table-scroll">
            <table className="min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-ink-muted">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Address
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Authorization
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Added
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Recorded submissions
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Last submission
                  </th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.address} className="border-b border-border/60 align-top">
                    <td className="py-3 pr-4">
                      <IdentifierDisplay kind="address" value={node.address} />
                    </td>
                    <td className="py-3 pr-4">
                      {node.active ? (
                        <StatusBadge tone="success">active authorization</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">removed</StatusBadge>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <Freshness timestamp={node.addedAt} />
                    </td>
                    <td className="py-3 pr-4 font-mono text-ink-primary">{node.submissionCount}</td>
                    <td className="py-3 pr-4">
                      {node.lastSubmissionAt ? (
                        <Freshness timestamp={node.lastSubmissionAt} staleAfterSeconds={STALE_AFTER_SECONDS} />
                      ) : (
                        <span className="font-mono text-xs text-ink-muted">no submissions recorded</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Provenance />
        </>
      )}
    </main>
  );
}

function Header() {
  return (
    <div>
      <h1 className="font-display text-4xl text-ink-primary">Reporting Network</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        The accounts currently authorized to submit commodity prices to the AgriFeedOracle
        contract on Stellar Testnet, indexed from real on-chain add_node / remove_node events and
        submit_price calls — never seeded or invented.
      </p>
    </div>
  );
}

function Summary({
  authorizedCount,
  totalSubmissions,
  lastActivity,
  stale,
}: {
  authorizedCount: number;
  totalSubmissions: number;
  lastActivity: string | null;
  stale: boolean;
}) {
  return (
    <div className="card mt-8 flex flex-wrap gap-x-8 gap-y-3 p-4">
      <div>
        <p className="font-mono text-2xl text-ink-primary">{authorizedCount}</p>
        <p className="text-xs text-ink-muted">authorized reporting node{authorizedCount === 1 ? "" : "s"}</p>
      </div>
      <div>
        <p className="font-mono text-2xl text-ink-primary">{totalSubmissions}</p>
        <p className="text-xs text-ink-muted">recorded submissions, all time</p>
      </div>
      <div>
        {lastActivity ? (
          <div className={`font-mono text-sm ${stale ? "text-status-warning" : "text-ink-primary"}`}>
            <Freshness timestamp={lastActivity} staleAfterSeconds={STALE_AFTER_SECONDS} />
          </div>
        ) : (
          <p className="font-mono text-sm text-ink-muted">no recorded activity</p>
        )}
        <p className="text-xs text-ink-muted">most recent recorded activity</p>
      </div>
    </div>
  );
}

function Provenance() {
  return (
    <section className="mt-10 max-w-2xl border-t border-border pt-6 text-sm text-ink-muted">
      <h2 className="font-display text-base text-ink-primary">What this page does and doesn&apos;t show</h2>
      <p className="mt-2">
        The oracle finalizes a price only once enough independently-submitted observations agree,
        so more authorized reporting nodes reduce reliance on any single submitter — that
        mechanism is real and on-chain. This page does not claim these accounts are
        independently operated: it shows only what add_node, remove_node, and submit_price
        events actually record. Every address, submission count, and timestamp here is publicly
        inspectable and comes from indexed on-chain history, not a live read on every visit. See{" "}
        <Link href="/docs" className="text-accent hover:underline">
          Developers &amp; Docs
        </Link>{" "}
        for the underlying methodology.
      </p>
    </section>
  );
}
