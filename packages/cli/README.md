# gameable/cli

## What

The `gameable` command, and the guest build pipeline behind it.

- `dev` runs Vite in direct mode, so an edit to `src/game.ts` is a reload rather
  than a thirty-second componentize.
- `build` runs the whole shipping path — `jco guest-types`, `tsc --noEmit`,
  `jco componentize`, `jco transpile`, optional `wasm-opt -Oz`, `vite build` —
  and `--report` measures what it produced and enforces the budgets.
- `doctor` checks the toolchain and the manifest, and prints a copy-pasteable
  fix for every failure.
- `docs` says where the `llms*.txt` bundles are on this machine.

Everything it spawns is spawned with array arguments and no shell, and every
path it hands to jco is absolute and forward-slashed, because Windows paths
break shell-string pipelines.

## When to use

You are working inside a generated game; the template wires these into its own
npm scripts, so you normally type `npm run dev` and `npm run build`. Reach for
the package API when you are writing tooling — `gameable/vite`
calls `guestBuild` directly.

## Install

```sh
npm install --save-dev gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { guestBuild } from 'gameable/cli';

const result = await guestBuild({
  gameDir: 'F:/games/my-fps',
  release: true,
  onLog: (line) => console.log(line),
});

console.log(result.guestEntry); // 'F:/games/my-fps/dist/guest/game.js'
console.log(result.wasmBytes); // 2173240
```

## API

Command line:

| Command                                                         | Does                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `gameable dev [--wasm] [--port <n>] [--host] [--open]`          | Vite; `--wasm` builds the component first and sets `GAMEABLE_WASM=1`  |
| `gameable build [--release] [--report] [--no-wasm] [--no-gate]` | the shipping path; `--ticks <n>` sets how many ticks `--report` times |
| `gameable serve [--direct]`                                     | the room server; see `gameable/rooms`                                 |
| `gameable doctor [--quiet]`                                     | eleven checks; the exit code is the number of failures                |
| `gameable docs [fps\|third-person\|index\|full] [--open]`       | where the bundles are                                                 |

Package:

- `guestBuild(options)` — the pipeline. Returns where the outputs landed, the
  component size and how long it took.
- `resolveToolchain(gameDir)` — jco, the WIT package, `gameable` and
  binaryen, resolved from the game, then the monorepo, then the CLI's own copy.
- `generateGuestTypes(toolchain, outDir)` — `jco guest-types` on its own.
- `measure({ wasmPath, guestDir, ticks })`, `checkGates`, `formatReport`,
  `DEFAULT_GATES` — the `--report` numbers, separated from the printing.
- `runChecks(deps)` — the doctor, with its filesystem, child processes and
  module resolution injected, so it tests with fakes and no toolchain.
- `parseArgs(argv, spec)`, `filterJcoNoise(text)`, `toPosix`,
  `relativeSpecifier` — the small pieces, exported because
  `create-gameable` and the templates need the same behaviour.

## Gotchas

- **`wasm-opt` runs after `jco transpile`, not before.** Binaryen cannot parse a
  WebAssembly _component_ — it says so, loudly — so `--release` optimises the
  core modules jco unpacked into `dist/guest`. That is the only shape that
  reaches the browser anyway.
- **Red `UNRESOLVED_IMPORT` warnings from componentize are expected.** rolldown
  bundles before the component is linked, so `gameable:engine/*@0.2.0` genuinely is
  unresolvable at that point; componentize supplies it afterwards.
  `filterJcoNoise` strips the blocks, so if you see one, something else printed it.
- **`doctor` exits with the number of failures, not 1.** `gameable doctor && …`
  works; `if [ $? -eq 1 ]` does not.
- **`npm` is never spawned as `npm`.** On Windows it is a `.cmd` shim and node
  refuses to spawn one without a shell, so the doctor runs `node npm-cli.js`.
- **The engine packages are loaded through variable specifiers.** `--report`
  imports the game's own `gameable/host`, and a bundler must not inline
  either of them into this package.
