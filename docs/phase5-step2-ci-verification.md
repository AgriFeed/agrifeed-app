# Phase 5 Step 2: Restore Trustworthy CI Verification

**Baseline**: `origin/main` at `5f2ec92` (Phase 5 Step 1, readiness/scope
audit). This step makes exactly one change: `.github/workflows/ci.yml`'s
`node` job now provisions the Postgres service the indexer's real-database
tests require. No application code was touched.

## Original failure

Every push since `de12ce2` (2026-09-09) through `5f2ec92` (9+ consecutive
pushes, spanning the tail of Phase 3 and the whole of Phase 4) failed the
`node` job's `pnpm test` step:

```
services/indexer test: Error: connect ECONNREFUSED ::1:5433
FAIL src/instances.test.ts / src/poll.test.ts / src/db/schema.test.ts / src/api/deals.test.ts
Tests  2 failed | 51 skipped (53)
```

`typecheck` and `lint` passed; `pnpm build` never ran (the recursive
`pnpm test` script aborts the whole job on first workspace failure). This
was first surfaced by [Phase 5 Step 1](./phase5-readiness-and-scope.md)'s
audit — it had not been previously reported anywhere in this project.

## Root cause

1. **Which job runs the full suite**: `node` is the only CI job that runs
   `pnpm test` (root-level, `pnpm -r --if-present run test`, which
   fans out to `packages/sdk`, `apps/web`, and `services/indexer`). A
   separate `indexer-migration` job exists, but it only runs `pnpm
   --filter @agrifeed/indexer migrate` — never the test suite — and was
   passing throughout, which is exactly why the gap went unnoticed: the
   only job that *did* touch Postgres was never the one running tests.
2. **What the failing tests need**: `services/indexer`'s four
   Postgres-backed test files (`instances.test.ts`, `poll.test.ts`,
   `db/schema.test.ts`, `api/deals.test.ts`) each default
   `TEST_DATABASE_URL`/`INDEXER_TEST_DATABASE_URL` to
   `postgres://postgres:postgres@localhost:5433/agrifeed_test?sslmode=disable`
   when the env var isn't set (confirmed by reading each file's own
   fallback). The `node` job provisioned no database at any port, so
   every one of those four files' `beforeAll` (which opens the pool and
   applies `schema.sql`) failed immediately with `ECONNREFUSED`.

## Changed workflow/job

Only `.github/workflows/ci.yml`'s `node` job changed. `indexer-migration`
and `research` are byte-for-byte unchanged (requirement: keep the
migration job intact).

### Postgres setup

Added a `postgres:16-alpine` service to the `node` job, matching
`indexer-migration`'s own service block almost exactly (same image, same
health-check pattern) but with the database name and host port this
project's test files already assume by default, so no test file needed
to change and no new environment-variable convention was invented:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: agrifeed_test
    ports:
      - 5433:5432
    options: >-
      --health-cmd "pg_isready -U postgres"
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
```

`postgres`/`postgres` is not a real secret: it is the same placeholder
credential already used in `indexer-migration`'s own service, in
`docker-compose.yml`, and in `.env.example` — a CI-local, throwaway
database that exists only for the lifetime of the job. No credential was
hardcoded anywhere that wasn't already hardcoded the same way elsewhere
in this repo.

### Readiness check

`--health-cmd "pg_isready -U postgres"` with a 5-second interval and 10
retries — the exact convention `indexer-migration` already used. This is
GitHub Actions' native service-container health check: the platform
itself blocks the job's steps from starting until the service reports
healthy, so no custom polling loop or `sleep N` was added or needed
(the requirement was a deterministic readiness check, not an arbitrary
wait — this reuses the mechanism this repo already trusted for the
migration job rather than inventing a second one).

### Migration setup

Added one new step, before `pnpm test`, that runs the indexer's real
`migrate()` against the fresh CI database:

```yaml
- name: Verify indexer migrations apply cleanly to a fresh database
  run: pnpm --filter @agrifeed/indexer migrate
  env:
    DATABASE_URL: postgres://postgres:postgres@localhost:5433/agrifeed_test?sslmode=disable
```

This is not strictly load-bearing for the tests to pass — every one of
the four Postgres-backed test files already applies `schema.sql` itself
in its own `beforeAll` (confirmed by reading each file), and that
application is idempotent (`db/schema.test.ts`'s own regression test
proves `migrate()` twice in a row is safe). It is included anyway because
(a) it directly satisfies `CONTRIBUTING.md`'s own stated pre-PR gate —
"`pnpm --filter @agrifeed/indexer migrate` against a clean database to
confirm `schema.sql` still applies cleanly" — as an actual CI-enforced
check rather than a trust-the-contributor step, and (b) it gives an
earlier, more specific failure point (a real migration bug fails here
with a clear name, instead of surfacing indirectly as four unrelated test
file failures downstream).

### Test command

Unchanged (`pnpm test`, i.e. `pnpm -r --if-present run test`), now with
the database it always needed:

```yaml
- run: pnpm test
  env:
    INDEXER_TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5433/agrifeed_test?sslmode=disable
```

Passed explicitly (rather than relying on the test files' own matching
default) so the CI config is self-documenting about which database it
provides, per the requirement to configure the job with the correct host/
port/database/user/password rather than rely on a coincidental match.

No test was skipped, weakened, mocked, or replaced with a fallback: the
same four real-Postgres test files, the same real Testnet RPC calls
inside `instances.test.ts`'s `registerInstance` tests, unchanged.

## Local verification (this step)

Re-run against the working tree with the CI change applied, before any
push:

| Check | Result |
|---|---|
| `pnpm typecheck` | Pass, all 4 workspaces |
| `pnpm lint` | Pass, no warnings |
| `pnpm test` | **123 passed** (27 SDK + 43 web + 53 indexer), 0 failed |
| `pnpm build` | Pass, all 4 workspaces |

Local test counts are unchanged from Phase 4 Step 7 and Phase 5 Step 1 —
this step's change is CI-only, so local behavior was never expected to
differ, and it doesn't.

## CI run: confirmed, real, successful

Pushed as `4c72a20` ("ci: provision postgres for full test suite").
Triggered run: [`34491438284`](https://github.com/AgriFeed/agrifeed-app/actions/runs/34491438284),
2026-09-10T14:48:02Z. **All three jobs passed** (`gh run watch
34491438284 --exit-status` exited 0):

```
✓ node in ~1m (typecheck, lint, migrate, test, build all green)
✓ indexer-migration in 29s
✓ research in 32s
```

Exact log output from the `node` job's `pnpm test` step, this run, not
predicted:

```
packages/sdk test:      Test Files  4 passed (4)
packages/sdk test:           Tests  27 passed (27)
apps/web test:          Test Files  3 passed (3)
apps/web test:               Tests  43 passed (43)
services/indexer test:  Test Files  4 passed (4)
services/indexer test:       Tests  53 passed (53)
```

No `ECONNREFUSED`, no failed suites, no skipped tests — all four
previously-failing indexer test files (`instances.test.ts`,
`poll.test.ts`, `db/schema.test.ts`, `api/deals.test.ts`) ran and passed
against the real provisioned Postgres. The new "Verify indexer migrations
apply cleanly to a fresh database" step logged `{"level":"info","msg":"migration complete"}`
before the test step ran, confirming migrations applied cleanly to a
genuinely fresh CI database (not a pre-seeded or cached one). `pnpm
build` also ran and passed — the first time it has actually executed in
CI since `de12ce2`, since `test` failing aborted the job before `build`
could run on every prior attempt. `indexer-migration`'s own separate
migration step also logged `migration complete` and stayed green,
confirming it was unaffected by the `node` job's change.

## Test count comparison

| | Total | SDK | Web | Indexer |
|---|---|---|---|---|
| Local (this step, pre-push) | 123 | 27 | 43 | 53 |
| CI, this run (`34491438284`) | **123** | 27 | 43 | 53 |
| CI, every prior run since `de12ce2` | 70 counted passing, then aborted | 27 | 43 | 2 failed / 51 never ran |

**No difference** between the local and CI totals — 123 in both,
matching exactly at the per-workspace level, not just in aggregate. Prior
to this fix, CI's SDK and web counts were already correct (those
workspaces never depended on Postgres); only the indexer's 53 were
affected, and they are now fully accounted for: 2 tests that used to
report as explicitly failed and 51 that used to report as "skipped"
(Vitest's term for tests whose file-level `beforeAll` threw before any
individual test could run — not a deliberate exclusion) are now all 53
genuinely executed and passing.

## Remaining CI limitations

Carried forward from [Phase 5 Step 1](./phase5-readiness-and-scope.md)
and unchanged by this fix — none of these are regressions from this
step, and none were in this step's scope to resolve:

- `instances.test.ts`'s `registerInstance` tests make real, live calls to
  Testnet RPC (`https://soroban-testnet.stellar.org`) from inside the CI
  test run. Once this fix makes those tests actually execute in CI (they
  never did before, due to the earlier `ECONNREFUSED`), CI's green/red
  status for the indexer partially depends on Testnet RPC's own
  availability and latency, not just this repo's code. This is a known,
  already-flagged limitation (Phase 5 Step 1, finding I4), not something
  this step attempted to change — doing so would mean altering test
  behavior to accommodate CI, which this task's own requirements (11, 12)
  rule out.
- `services/node-relayer` still has no automated tests and is not part of
  any CI job's test step (Phase 5 Step 1, finding T4) — unrelated to this
  fix, unchanged.
- The CI Node 20 deprecation warning (already tracked as this repo's own
  open issue #3) is unaffected by this change; `node-version: 20` was
  left exactly as it was, since changing it was not in scope here.

## Files changed

```
.github/workflows/ci.yml              | +29 -0 (node job only; indexer-migration, research untouched)
docs/phase5-step2-ci-verification.md  | new (this file)
```

No application code, test file, contract, or schema was modified.
