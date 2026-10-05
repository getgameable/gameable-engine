import { defineConfig } from 'tsdown';

import { ENTRIES, THIRD_PARTY } from './entries.mjs';

// Deterministic output names, so the exports map does not depend on platform.
const outExtensions = (): { js: string; dts: string } => ({ js: '.js', dts: '.d.ts' });

const entriesFor = (platform: 'browser' | 'node'): Record<string, string> =>
  Object.fromEntries(
    ENTRIES.filter((e) => e.platform === platform).map((e) => [e.file, `src/${e.file}.ts`]),
  );

const shared = {
  format: ['esm' as const],
  // Declarations come from tsc instead (scripts/build-types.mjs): bundling them
  // through rolldown-plugin-dts emits nothing for workspace sources, or runs
  // out of memory in eager mode.
  dts: false,
  outExtensions,
  deps: {
    // The workspace packages are this package's sources: bundle them in.
    alwaysBundle: [/^@gameable\//],
    // Everything else is installed beside it: a dependency, a peer the app
    // owns (three) or an optional peer only some apps need (pg, colyseus,
    // jco...). `gameable:engine/*` exists only inside `jco componentize`.
    neverBundle: [THIRD_PARTY],
  },
  // Bundle the workspace packages from their sources, so this build never
  // takes a stale `dist/` of theirs.
  inputOptions: { resolve: { conditionNames: ['gameable-source', 'import', 'default'] } },
  // three's addons have no side effects on import.
  treeshake: { moduleSideEffects: (id: string) => !/^three\/addons\//.test(id) },
};

export default defineConfig([
  { ...shared, entry: entriesFor('browser'), platform: 'browser' },
  // The node build only adds its files beside the browser build's.
  {
    ...shared,
    entry: { ...entriesFor('node'), 'cli-bin': '../cli/src/bin.ts' },
    platform: 'node',
    clean: false,
  },
]);
