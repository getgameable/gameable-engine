import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/prelude.ts', 'src/keycodes.ts', 'src/wire.ts', 'src/wit/entry.ts'],
  deps: { neverBundle: [/^gameable:engine\//] },
  format: ['esm'],
  dts: true,
  platform: 'browser',
  // Deterministic output names, so the exports map does not depend on platform.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
