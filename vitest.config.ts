import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Run packages straight from TypeScript source, exactly as `npm run dev` does.
  resolve: {
    conditions: ['gameable-source'],
  },
  // vitest's node environment resolves through the SSR conditions, which are separate.
  ssr: { resolve: { conditions: ['gameable-source'] } },
  test: {
    include: [
      'packages/**/*.test.ts',
      'templates/**/*.test.ts',
      'examples/**/*.test.ts',
      'tests/**/*.test.ts',
      // The docs generator's own rules (tools/docs/llms/).
      'tools/docs/**/*.test.mjs',
    ],
    // The explicit include overrides vitest's default exclude, so restate it:
    // synced copies under dist/ (cli wit, create-gameable templates) must not be collected.
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.gameable/**'],
    environment: 'node',
  },
});
