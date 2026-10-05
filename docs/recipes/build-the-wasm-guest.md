# Build the wasm guest

## Goal

Your game's TypeScript becomes a WebAssembly component that the host can
instantiate — the shipping path, rather than the `direct` mode `npm run dev`
uses.

## Files you will edit

- `scripts/build.mjs`
- `package.json`

## Steps

1. Write the build script. Three jco steps, every path absolute and
   forward-slashed, because Windows paths break shell-string pipelines.
   `fixtures/tiny-game/scripts/build.mjs` is the reference; the shape is:

   ```js
   // scripts/build.mjs
   import { spawnSync } from 'node:child_process';
   import { mkdirSync, writeFileSync } from 'node:fs';
   import { fileURLToPath } from 'node:url';

   const GAME = fileURLToPath(new URL('../', import.meta.url))
     .replaceAll('\\', '/')
     .replace(/\/$/, '');
   const BUILD = `${GAME}/build`;
   const JCO = `${GAME}/node_modules/@bytecodealliance/jco/dist/jco.js`;
   // The authored WIT package. `gameable build` resolves this for you; a
   // hand-rolled script points at the copy that ships with the engine.
   const WIT = `${GAME}/wit`;

   const jco = (args) => {
     const r = spawnSync(process.execPath, [JCO, ...args], { stdio: 'inherit' });
     if (r.status !== 0) throw new Error(`jco ${args[0]} failed`);
   };

   mkdirSync(BUILD, { recursive: true });

   // jco componentize compiles exactly one module, and that module must import
   // the versioned gameable:engine specifiers. Generate it; never hand-write it.
   writeFileSync(
     `${BUILD}/entry.ts`,
     [
       `import { createGuestExports } from 'gameable/sdk/wit/entry';`,
       `import definition from '../src/game';`,
       ``,
       `export const game = createGuestExports(definition);`,
     ].join('\n'),
     'utf8',
   );

   // rolldown runs with platform "neutral", so the workspace `gameable-source`
   // export condition never applies. Alias the SDK onto its sources.
   writeFileSync(
     `${BUILD}/rolldown.config.mjs`,
     `export default { resolve: { alias: { 'gameable': '${GAME}/node_modules/gameable/sdk/src/index.ts' } } };`,
     'utf8',
   );

   jco([
     'componentize',
     '--backend',
     'qjs',
     '--backend-qjs-disable-async',
     '-n',
     'game-module',
     '--wit',
     WIT,
     '--bundle-config',
     `${BUILD}/rolldown.config.mjs`,
     '-o',
     `${BUILD}/game.wasm`,
     `${BUILD}/entry.ts`,
   ]);

   jco([
     'transpile',
     `${BUILD}/game.wasm`,
     '--instantiation',
     'async',
     '--no-nodejs-compat',
     '--name',
     'game',
     '-o',
     `${BUILD}/guest`,
   ]);
   ```

2. Wire it up and ignore the output.

   ```diff
    // package.json
    "scripts": {
   +  "build:guest": "node scripts/build.mjs"
    }
   ```

   Add `build/` to `.gitignore`. It is a 2 MiB component plus nine core wasm
   files, all reproducible.

## Verify

```sh
npm run build:guest
```

`jco componentize` prints red `UNRESOLVED_IMPORT` warnings for the
`gameable:engine/*` specifiers — that is expected noise, not a failure;
componentize resolves them itself, after the bundle. It then prints
`OK Successfully written .../build/game.wasm`, and `jco transpile` lists nine
`.core*.wasm` files plus `game.js`. Load it with
`createSandbox({ mode: 'wasm', guestModuleUrl, getCoreModule, host })` and the
first `tick` should return the same `frame-output` hash as `mode: 'direct'`.

## See also

- [The wasm boundary](../concepts/wasm-boundary.md)
- [Write a game system](./write-a-game-system.md)
- `packages/wasm-host/README.md` — gameable/host
- [Troubleshooting](../troubleshooting.md)
