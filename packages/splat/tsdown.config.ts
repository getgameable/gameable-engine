import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/bench/index.ts'],
  format: ['esm'],
  dts: true,
  platform: 'browser',
  // three is a peer, not a dependency: bundling it here would ship a second copy of the core
  // classes and break `instanceof` against the app's own three — the exact singleton problem
  // `gameable/no-bare-three-import` exists to prevent. The addon loaders this package pulls
  // in (`three/addons/loaders/...`) import bare 'three' themselves, so the pattern has to
  // cover every subpath.
  external: [/^three(\/.*)?$/],
  // Deterministic output names, so the exports map does not depend on platform.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
