import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  platform: 'node',
  // The engine packages are loaded at runtime through variable specifiers and
  // jco, tsc, vite and wasm-opt are spawned as child processes, so there is
  // nothing to bundle in beyond this package's own sources.
  // Deterministic output names, so the exports map does not depend on platform.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
