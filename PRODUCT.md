# AgriFeed: product overview

## The problem

Smallholder and mid-size farmers who grow export commodities (cocoa,
coffee, wheat, maize, rice, soybeans, sugar, cotton) are price takers.
Between planting and harvest, a farmer has no way to lock in a minimum
sale price without a bank relationship, a broker, or a futures account,
none of which are available to most producers in the regions that grow
these crops. Existing commodity price benchmarks (FAO, IMF, AMIS) are
published for policy and research use, not built to be read by a smart
contract, and none of them alone is trustworthy enough to settle real
money against: any single data provider going stale, changing
methodology, or simply having an outage becomes a single point of failure
for anyone who priced a contract off it.

## What AgriFeed is

An open, decentralized price oracle for agricultural commodities on
Stellar, plus one real financial primitive built on top of it.

- **AgriFeedOracle**: a SEP-40-compatible price feed. Independent node
  operators each pull from real public sources (FAO, IMF; see
  `research/METHODOLOGY.md` for why AMIS is not a price source) and
  submit prices on a schedule. The contract only finalizes a price once
  enough independent nodes agree, via a median-of-N, so no single
  operator or single upstream data source can move the published price
  alone.
- **AgriPriceFloor**: a minimum-price guarantee contract between a farmer
  and a buyer, settled against AgriFeedOracle at maturity. If the market
  price falls below the agreed floor, the buyer's escrowed funds top up
  the farmer to the floor price. If it doesn't, the buyer keeps the
  difference. This is the smallest possible version of the price
  protection that commodity futures give large producers, made usable by
  someone with just a wallet.

## Who this is for

- **Farmers and buyers** who want a floor-price agreement without a
  brokerage relationship, demonstrated end to end on `/demo`. Every
  registered deal stays discoverable afterward, by address, on `/deals`,
  independent of the browser tab it was created in, though the two-party
  signing session itself is never recoverable if it's interrupted before
  the agreement is initialized on-chain, see `/docs#my-deals`.
- **Developers** who want a commodity price feed they can call from their
  own Soroban contract, or over REST, documented on `/docs`, including
  the persistent PriceFloor deal registry (`/api/deals`) alongside the
  oracle's own read API.
- **Reviewers and node operators** deciding whether to trust or run this
  feed, who can check the actual node set and submission history on
  `/nodes` and `/commodity/[symbol]`, not just take a claim of
  decentralization on faith.

## Why this repo is structured the way it is

`agrifeed-contract` holds only the Soroban contracts. Everything that
talks to the outside world, the frontend that makes the feed legible to a
human, the SDK both other services and third parties use, the indexer
that makes the chain queryable without an RPC dependency, and the node
relayer that is the actual write path into the oracle, lives here, in
`agrifeed-app`, because an oracle's trustworthiness is inseparable from
how transparently its off-chain half is built. See the root `README.md`
for the concrete reasoning per service.
