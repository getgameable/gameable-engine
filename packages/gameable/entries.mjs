/**
 * The one table behind the published `gameable` package: every public subpath,
 * the workspace module it re-exports, the flat file it builds to and the
 * platform it builds for.
 *
 * `scripts/gen-entries.mjs` turns it into `src/*.ts` and the `exports` map;
 * `tsdown.config.ts` turns it into the two builds. `npm run gen:check -w
 * packages/gameable` (part of the test suite) fails when a workspace export has
 * no row here and is not listed in PRIVATE_EXPORTS.
 *
 * Every output file sits directly in `dist/`, never in a subdirectory, so the
 * `new URL('../assets/', import.meta.url)` and `./vendor/riglogic.wasm` lookups
 * in the bundled code resolve against the package root exactly as they do
 * from each workspace package's own `src/`.
 *
 * @type {ReadonlyArray<{ subpath: string, from: string, file: string, platform: 'browser' | 'node' }>}
 */
export const ENTRIES = [
  { subpath: '.', from: '@gameable/sdk', file: 'index', platform: 'browser' },
  {
    subpath: './sdk/prelude',
    from: '@gameable/sdk/prelude',
    file: 'sdk-prelude',
    platform: 'browser',
  },
  {
    subpath: './sdk/keycodes',
    from: '@gameable/sdk/keycodes',
    file: 'sdk-keycodes',
    platform: 'browser',
  },
  { subpath: './sdk/wire', from: '@gameable/sdk/wire', file: 'sdk-wire', platform: 'browser' },
  {
    subpath: './sdk/wit/entry',
    from: '@gameable/sdk/wit/entry',
    file: 'sdk-wit-entry',
    platform: 'browser',
  },
  { subpath: './core', from: '@gameable/core', file: 'core', platform: 'browser' },
  {
    subpath: './core/render',
    from: '@gameable/core/render',
    file: 'core-render',
    platform: 'browser',
  },
  {
    subpath: './core/headless',
    from: '@gameable/core/headless',
    file: 'core-headless',
    platform: 'browser',
  },
  { subpath: './splat', from: '@gameable/splat', file: 'splat', platform: 'browser' },
  {
    subpath: './splat/bench',
    from: '@gameable/splat/bench',
    file: 'splat-bench',
    platform: 'browser',
  },
  { subpath: './character', from: '@gameable/character', file: 'character', platform: 'browser' },
  {
    subpath: './character/aosrig',
    from: '@gameable/character/aosrig',
    file: 'character-aosrig',
    platform: 'browser',
  },
  { subpath: './animation', from: '@gameable/animation', file: 'animation', platform: 'browser' },
  { subpath: './physics', from: '@gameable/physics-jolt', file: 'physics', platform: 'browser' },
  { subpath: './input', from: '@gameable/input', file: 'input', platform: 'browser' },
  { subpath: './audio', from: '@gameable/audio', file: 'audio', platform: 'browser' },
  {
    subpath: './audio/testing',
    from: '@gameable/audio/testing',
    file: 'audio-testing',
    platform: 'browser',
  },
  { subpath: './assets', from: '@gameable/assets', file: 'assets', platform: 'browser' },
  {
    subpath: './assets/node',
    from: '@gameable/assets/node',
    file: 'assets-node',
    platform: 'node',
  },
  { subpath: './aam', from: '@gameable/assets-aam', file: 'aam', platform: 'browser' },
  { subpath: './aosrig', from: '@gameable/assets-aosrig', file: 'aosrig', platform: 'browser' },
  {
    subpath: './placeholder',
    from: '@gameable/assets-placeholder',
    file: 'placeholder',
    platform: 'browser',
  },
  { subpath: './host', from: '@gameable/wasm-host', file: 'host', platform: 'browser' },
  {
    subpath: './host/characters',
    from: '@gameable/wasm-host/characters',
    file: 'host-characters',
    platform: 'browser',
  },
  {
    subpath: './host/features',
    from: '@gameable/wasm-host/features',
    file: 'host-features',
    platform: 'browser',
  },
  {
    subpath: './host/server',
    from: '@gameable/wasm-host/server',
    file: 'host-server',
    platform: 'node',
  },
  { subpath: './net', from: '@gameable/net', file: 'net', platform: 'browser' },
  {
    subpath: './net/client',
    from: '@gameable/net/client',
    file: 'net-client',
    platform: 'browser',
  },
  { subpath: './net/page', from: '@gameable/net/page', file: 'net-page', platform: 'browser' },
  { subpath: './net/solo', from: '@gameable/net/solo', file: 'net-solo', platform: 'browser' },
  { subpath: './net/server', from: '@gameable/net/server', file: 'net-server', platform: 'node' },
  {
    subpath: './net/testing',
    from: '@gameable/net/testing',
    file: 'net-testing',
    platform: 'node',
  },
  { subpath: './rooms', from: '@gameable/rooms', file: 'rooms', platform: 'browser' },
  {
    subpath: './rooms/client',
    from: '@gameable/rooms/client',
    file: 'rooms-client',
    platform: 'browser',
  },
  {
    subpath: './rooms/server',
    from: '@gameable/rooms/server',
    file: 'rooms-server',
    platform: 'node',
  },
  {
    subpath: './rooms/testing',
    from: '@gameable/rooms/testing',
    file: 'rooms-testing',
    platform: 'node',
  },
  {
    subpath: './conversation',
    from: '@gameable/conversation',
    file: 'conversation',
    platform: 'browser',
  },
  {
    subpath: './conversation/relay',
    from: '@gameable/conversation/relay',
    file: 'conversation-relay',
    platform: 'node',
  },
  { subpath: './voice', from: '@gameable/voice', file: 'voice', platform: 'browser' },
  { subpath: './test', from: '@gameable/test-harness', file: 'test', platform: 'browser' },
  { subpath: './three', from: '@gameable/gameable-character', file: 'three', platform: 'browser' },
  { subpath: './vite', from: '@gameable/vite-plugin-gameable', file: 'vite', platform: 'node' },
  { subpath: './cli', from: '@gameable/cli', file: 'cli', platform: 'node' },
];

/**
 * Directories copied into the package by `scripts/sync-files.mjs`, which runs
 * on install (`prepare`), so `gameable/assets/arena.spz?url` resolves in the
 * workspace without a build. Both packs share one directory, and the bundled
 * packs find their files through `new URL('../assets/', import.meta.url)`.
 */
export const FILES = [
  { from: '../assets-placeholder/assets', to: 'assets' },
  { from: '../assets-aosrig/assets', to: 'assets' },
  { from: '../../wit', to: 'wit' },
];

/** Copied into `dist/` after tsdown. */
export const DIST_FILES = [
  { from: '../character/src/rig/orl/vendor/riglogic.wasm', to: 'dist/vendor/riglogic.wasm' },
];

/**
 * A bare specifier of a third-party package: installed beside `gameable`
 * (a dependency, a peer the app owns such as three, or an optional peer such
 * as pg), so never bundled. Not a workspace package, not a relative or
 * absolute path (tsdown also tests resolved ids), not a builtin, not virtual.
 */
export const THIRD_PARTY = /^(?!@gameable\/)(?![./\\])(?![A-Za-z]:)(?!node:)(?!\0)./;

/** Workspace exports that are deliberately not their own public subpath. */
export const PRIVATE_EXPORTS = [
  '@gameable/sdk/package.json',
  '@gameable/sdk/wit/*.wit', // gameable/wit/*.wit
  '@gameable/cli/package.json',
  '@gameable/assets-aosrig/assets/*', // gameable/assets/*
  '@gameable/assets-placeholder/assets/*', // gameable/assets/*
  '@gameable/character/tools/gnm_neutral_pack.py',
  '@gameable/character/tools/gnm_pack.py',
];
