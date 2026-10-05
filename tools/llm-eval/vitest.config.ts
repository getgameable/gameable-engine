import { defineConfig } from 'vitest/config';

/**
 * The harness's own tests.
 *
 * They are not collected by the root `vitest.config.ts`, whose `include` is
 * `packages/**` and `tests/**`. Run them with the root install's vitest:
 *
 * ```sh
 * npx vitest run -c tools/llm-eval/vitest.config.ts
 * ```
 *
 * Everything here runs offline against the fake model client. The one test
 * that scaffolds and scores a real game is gated behind `GAMEABLE_LLM_EVAL_SLOW=1`.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'results/**'],
    environment: 'node',
    // The slow end-to-end test scaffolds a game, installs once and builds it.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
