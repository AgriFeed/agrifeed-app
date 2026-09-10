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

## CI run: pending push

**This is not yet complete per this task's own acceptance criteria.**
Requirements 17-20 explicitly require pushing the change and inspecting
a real GitHub Actions run — "the task is not complete merely because the
YAML parses or local tests pass" (requirement 18). Consistent with every
prior step in this project's workflow, this session does not push to
`origin/main` without an explicit, exact command from the user in a
separate turn. The workflow file is currently modified in the working
tree, not committed, and nothing has been pushed.

Once pushed, the expected result (based on the CI failure log's own
already-passing sdk/web test counts, unaffected by this change, plus this
step's local indexer results) is:

- `node` job: `typecheck` ✓, `lint` ✓, migrate-against-fresh-DB ✓,
  `pnpm test` → **123/123** (27 SDK + 43 web + 53 indexer, all four
  currently-failing indexer test files passing against a real reachable
  Postgres instead of `ECONNREFUSED`), `pnpm build` ✓ (this step is the
  first time `build` will actually run in CI since `de12ce2`, since
  `test` failing before it aborted the job every time until now).
  Expected CI total: **123**, matching the local total exactly.
- `indexer-migration` job: unchanged, expected to remain green as it has
  throughout.
- `research` job: unchanged, unaffected, expected to remain green.

**This report will be updated with the actual run result (job status,
exact test count reported by CI, run URL) once the change is pushed and
that run completes** — the placeholder above is a prediction based on
local evidence, not a substitute for requirement 19's "real successful
CI run."

## Test count comparison

Local: 123 (27 + 43 + 53), confirmed this step. CI, prior to this fix: 70
counted as passing before the indexer suite aborted (27 SDK + 43 web),
with the indexer's 53 never actually completing (2 explicitly failed, 51
never ran — recorded by Vitest as "skipped" because each file's
`beforeAll` threw before any of its tests could execute, not because
anything was deliberately excluded). Once pushed, CI is expected to match
local exactly at 123 — see above; this will be confirmed, not assumed, in
the update to this report.

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
