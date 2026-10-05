import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  platform: 'node',
  // Deterministic output names, so the exports map does not depend on platform.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
