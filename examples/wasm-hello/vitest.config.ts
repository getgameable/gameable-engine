import { defineConfig } from 'vitest/config';

/**
 * The example's own unit test.
 *
 * It drives the guest through `gameable/test`: no browser, no
 * renderer, no character bridge. The point it proves is that the guest sends
 * one `spawn-character` and one `set-clip-weights` and then nothing at all.
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
