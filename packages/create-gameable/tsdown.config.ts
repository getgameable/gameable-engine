import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  platform: 'node',
  // Deterministic output names, so the exports map does not depend on platform.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
