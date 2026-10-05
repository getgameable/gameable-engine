import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing/fakeAudioContext.ts'],
  format: ['esm'],
  dts: true,
  platform: 'browser',
  // Sibling workspace packages stay external. `gameable/core` is imported for
  // types only, and inlining it would make this build depend on core's `dist`
  // being freshly built first.
  deps: { neverBundle: [/^@gameable\//] },
  // Deterministic output names, so the exports map does not depend on platform.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
