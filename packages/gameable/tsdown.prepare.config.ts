import { defineConfig } from 'tsdown';

import { THIRD_PARTY } from './entries.mjs';

// What `npm install` builds (the `prepare` script): only the Node tooling a
// game's own config and scripts load natively, outside any bundler, so the
// `gameable-source` condition cannot reach them — `gameable/vite` from
// vite.config.ts, the `gameable` command, and a relay script's
// `gameable/conversation/relay`. The full build is `npm run build`.
export default defineConfig({
  entry: {
    vite: 'src/vite.ts',
    cli: 'src/cli.ts',
    'cli-bin': '../cli/src/bin.ts',
    'conversation-relay': 'src/conversation-relay.ts',
  },
  format: ['esm'],
  dts: false,
  platform: 'node',
  clean: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    alwaysBundle: [/^@gameable\//],
    neverBundle: [THIRD_PARTY],
  },
  inputOptions: { resolve: { conditionNames: ['gameable-source', 'import', 'default'] } },
  logLevel: 'warn',
});
