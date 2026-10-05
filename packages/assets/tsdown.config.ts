import { defineConfig } from 'tsdown';

// Two builds: the package root is browser code; `./node` (src/node.ts) is for
// Node hosts and imports `node:module`, so it is built for that platform.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    platform: 'browser',
    // Deterministic output names, so the exports map does not depend on platform.
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  {
    entry: ['src/node.ts'],
    format: ['esm'],
    dts: true,
    platform: 'node',
    // The browser build above owns dist/: this one only adds its files.
    clean: false,
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
]);
