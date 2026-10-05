import { defineConfig } from 'vitest/config';

/**
 * The game's own unit tests.
 *
 * They drive the guest directly through `gameable/test`: no browser,
 * no renderer, no physics — a mock host answers the queries and the same
 * systems run. That is the fast loop for gameplay work; the end-to-end suite
 * in `tests/e2e` is the slow one.
 */
export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript sources, as the dev server does.
    conditions: ['gameable-source'],
  },
  // vitest's node environment resolves through the SSR conditions, which are separate.
  ssr: { resolve: { conditions: ['gameable-source'] } },
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
