import { defineConfig } from 'vitest/config';

/**
 * The boundary suite. Separate from the root config because it needs a real
 * `jco componentize` build, a long timeout, and a single worker.
 *
 * ```sh
 * GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts
 * ```
 *
 * The same files are visible to the root `npm test` (its include covers
 * `tests/**`), where they skip themselves unless `GAMEABLE_BOUNDARY=1` is set.
 */
export default defineConfig({
  // Packages resolve to `src/`, exactly as `npm run dev` does.
  resolve: {
    conditions: ['gameable-source'],
  },
  // vitest's node environment resolves through the SSR conditions, which are separate.
  ssr: { resolve: { conditions: ['gameable-source'] } },
  test: {
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./global-setup.ts'],
    // A cold componentize is around 30 seconds; instantiating the component is
    // another second or so per suite.
    testTimeout: 120_000,
    hookTimeout: 600_000,
    // One component instance at a time: a trapped instance poisons itself, and
    // the fixture build writes to a single output directory.
    fileParallelism: false,
  },
});
