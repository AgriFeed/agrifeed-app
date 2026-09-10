import { defineConfig } from "vitest/config";

// Every test file here shares one real Postgres database (see poll.test.ts's
// and instances.test.ts's own doc comments on why: this project's
// convention is real Postgres, not a mock). Phase 4 added a second file
// (instances.test.ts) that truncates/writes the same pricefloor_instances
// table poll.test.ts also uses, so running files in parallel (vitest's
// default) can race: one file's beforeEach TRUNCATE can wipe rows another
// file's test just inserted. Running files sequentially avoids that
// without adding per-file database isolation this project doesn't
// otherwise have.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
