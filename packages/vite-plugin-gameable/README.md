# gameable/vite

## What

The Vite plugin every Gameable Engine app uses. It is one line in `vite.config.ts`
and it replaces half a dozen unrelated settings, every one of which fails in a
way that looks like something else:

| Setting                                   | What goes wrong without it                                               |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `resolve.conditions: ['gameable-source']` | Workspace packages resolve to an unbuilt `dist/`                         |
| bare `three` aliased to `three/webgpu`    | Two three singletons; a `Vector3` from one is not `instanceof` the other |
| `optimizeDeps.exclude` for wasm runtimes  | esbuild rewrites the emscripten glue and the module never instantiates   |
| `.wasm` never inlined, `application/wasm` | `WebAssembly.instantiateStreaming` refuses the response                  |
| `import.meta.env.GAMEABLE_MODE`           | The app cannot tell which sandbox to build                               |
| `dist/guest/**`                           | The shipped build has no game module                                     |

## When to use

Any Vite app that embeds the engine. The templates and examples already
include it.

## Install

```sh
npm install -D gameable
```

Inside this repository the package is a workspace member and needs no install.
It is also the one package whose `dist/` has to exist before anything else can
run — a `vite.config.ts` is loaded by Node, which has no `gameable-source`
condition — so its `prepare` script builds it during `npm install`.

## Minimal example

```ts
import { gameable } from 'gameable/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [gameable()] });
```

Then, in the app:

```ts
if (import.meta.env.GAMEABLE_MODE === 'wasm') {
  const base = new URL(import.meta.env.GAMEABLE_GUEST_URL, location.href);
  sandbox = await createSandbox({ mode: 'wasm', guestModuleUrl: base.href, getCoreModule, host });
} else {
  sandbox = await createSandbox({ mode: 'direct', game: (await import('./game')).default, host });
}
```

## API

- `gameable(options?)` — the plugin. Add it to `plugins`.
- `options.mode` — force `'direct'` or `'wasm'`. The default derivation is:
  this option, then Vite's own `--mode` when it is `direct` or `wasm`, then
  `GAMEABLE_MODE` in the environment, then `GAMEABLE_WASM=1`, then `wasm` for
  `vite build` and `direct` for `vite dev`.
- `options.guestDir` — where `jco transpile` wrote the guest, relative to the
  Vite root. Default `build/guest`.
- `options.guestBase` — the path it is served from. Default `guest/`, so the
  entry is `<base>guest/game.js`.
- `options.three` / `options.source` — set either to `false` to opt out of
  the alias or the `gameable-source` resolve condition (`development` is the
  old name of `source`).
- `options.exclude` — extra packages kept out of the dependency pre-bundle.
- `resolveGameableMode(options, env)` / `resolveGameableConfig(options, env)` — the pure
  functions behind the plugin, so the behaviour is testable without a server.
- `ALWAYS_EXCLUDED`, `NEVER_INLINED` — the built-in lists.
- `import.meta.env.GAMEABLE_MODE` and `import.meta.env.GAMEABLE_GUEST_URL` — what the
  plugin defines for the app. Declare them in a `vite-env.d.ts`.

## Gotchas

- **`vite.config.ts` is loaded by Node, not by Vite's own resolver.** The
  `gameable-source` condition therefore does not apply to the config file itself,
  which is why this package ships a `dist/` built during `npm install`. A
  config that imports other workspace packages has the same problem.
- **Jolt's wasm needs a URL you control.** Import it as
  `import wasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url'` and hand it
  to `physics({ wasmUrl })` and `loadJolt({ wasmUrl })`; the plugin makes sure
  it is copied rather than inlined, but it cannot guess where you want it.
- **Building in `wasm` mode without a guest is a warning, not an error.** The
  bundle succeeds and the page fails at runtime with a 404. Run
  `npm run build:guest` first, or build with `--mode direct`.
- **The guest is served off disk in dev**, straight from `guestDir`, without
  passing through Vite's module graph. Rebuild it to see a change; there is no
  HMR for the component.
