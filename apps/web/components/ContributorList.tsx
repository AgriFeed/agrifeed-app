import { IdentifierDisplay } from "@/components/IdentifierDisplay";

/**
 * Contributing-node IDENTITIES for one specific finalized price (Phase 3
 * Step 7). Deliberately separate from NodeCount: this is "which addresses"
 * for one finalization, never conflated with "how many nodes total are
 * authorized." Renders nothing (not a zero) when the list is empty, since
 * an empty contributor list is itself meaningful evidence (see the F-06
 * fix), not an error state.
 */
export function ContributorList({ addresses }: { addresses: string[] }) {
  if (addresses.length === 0) {
    return <span className="text-xs text-ink-muted">no contributors recorded</span>;
  }
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {addresses.map((address) => (
        <li key={address}>
          <IdentifierDisplay kind="address" value={address} />
        </li>
      ))}
    </ul>
  );
}
