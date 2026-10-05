import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  platform: 'browser',
  // Sibling packages, three and Jolt are resolved by the consumer, never
  // inlined: bundling `three` would create a second three singleton, and
  // bundling `jolt-physics` would duplicate a two-megabyte wasm loader.
  deps: { neverBundle: [/^@gameable\//, /^three(\/|$)/, /^jolt-physics(\/|$)/] },
  // Deterministic output names, so the exports map does not depend on platform.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
