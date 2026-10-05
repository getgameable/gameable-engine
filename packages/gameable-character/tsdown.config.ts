import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  platform: 'browser',
  deps: {
    // three is the app's own: bundling it would ship a second copy of the core classes. The
    // engine packages this wraps are bundled in, so an app installs this one package and three.
    neverBundle: [/^three(\/.*)?$/],
    alwaysBundle: [/^@gameable\//],
  },
  // The engine packages are bundled from their sources (their `gameable-source` export), so
  // this build never takes a stale `dist/` of theirs.
  inputOptions: { resolve: { conditionNames: ['gameable-source', 'import', 'default'] } },
  // three's addons have no side effects on import: one the character never calls (the splat
  // file loaders gameable/splat's index re-exports) is dropped rather than kept as a bare import.
  treeshake: { moduleSideEffects: (id: string) => !/^three\/addons\//.test(id) },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
