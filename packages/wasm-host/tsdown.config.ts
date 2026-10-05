import { defineConfig } from 'tsdown';

// Deterministic output names, so the exports map does not depend on platform.
const outExtensions = (): { js: string; dts: string } => ({ js: '.js', dts: '.d.ts' });

export default defineConfig([
  {
    // `characters.ts` is its own entry, not a re-export from `index.ts`: it is
    // the only file in the package that imports the character, animation and
    // splat runtimes, and a game that never spawns a character must not pay for
    // them. See the module header for the whole argument.
    entry: ['src/index.ts', 'src/characters.ts', 'src/features.ts'],
    format: ['esm'],
    dts: true,
    platform: 'browser',
    outExtensions,
  },
  {
    // The room server's entry runs on Node (`gameable serve`), never in a page.
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['esm'],
    dts: true,
    platform: 'node',
    // The browser build above owns dist/: this one only adds its files.
    clean: false,
    outExtensions,
  },
]);
