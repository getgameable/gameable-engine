# gameable/host

## What

The host half of the wasm game-logic boundary. Loads the `jco transpile`d
component, supplies the `gameable:engine/*` host imports and a minimal WASI, encodes
`frame-input`, and applies `frame-output` to an `EngineAdapter`.

It also provides the `direct` sandbox, which runs the very same SDK guest
runtime in the host's own realm with no build step — that is what `npm run dev`
uses, and a parity test hashes both modes to keep them honest.

## When to use

You are embedding a compiled game module, or you want a sandbox in a test or a
dev server. Engine code implements `EngineAdapter`; tests use
`NullEngineAdapter`.

Three subpath entry points sit beside the index, each kept apart so a page or a
process loads only what it needs:

- **`gameable/host/features`** — a page booting a game that declares
  `features` in `defineGame` (ADR 0017). Every template uses it.
- **`gameable/host/characters`** — the character bridge itself; the
  `characters` feature loads it for you, so import it by hand only outside the
  feature loader.
- **`gameable/host/server`** — running a game as the authority of a
  room, on a headless engine with no renderer (ADR 0018). It imports no three.js.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { readFile } from 'node:fs/promises';
import { createSandbox, applyOutput, NullEngineAdapter, createInputEncoder } from 'gameable/host';

const adapter = NullEngineAdapter();
const encoder = createInputEncoder(4096);

const sandbox = await createSandbox({
  mode: 'wasm',
  guestModuleUrl: new URL('./build/guest/game.js', import.meta.url).href,
  getCoreModule: (p) => readFile(new URL(p, guestDir)).then((b) => WebAssembly.compile(b)),
  host, // your HostApi: log, seed, nowMs, raycast, resolveId, describe, ...
});

sandbox.init({
  seed: 0x5eed1234n,
  fixedHz: 60,
  viewportWidth: 1920,
  viewportHeight: 1080,
  devMode: true,
});

for (let frame = 0; frame < 600; frame += 1) {
  const input = encoder.encode({
    frame,
    dt: 1 / 60,
    elapsed: frame / 60,
    inputState,
    bodies,
    bodyCount,
  });
  applyOutput(adapter, sandbox.tick(input));
  if (sandbox.dead) break; // a trap poisons the instance; rebuild it
}
```

The same code with `{ mode: 'direct', game, host }` runs the game's TypeScript
straight from source.

### A page whose game declares features

`clientFeatures(overrides?)` is the page's feature table: each entry is a
dynamic `import()`, so a feature the game did not declare is never downloaded.
Page-owned options ride in the overrides.

```ts
import { bindFeatures, createEngine, resolveFeatures } from 'gameable/core';
import { featuresOf } from 'gameable';
import type { CharacterBridge } from 'gameable/host/characters';
import { clientFeatures } from 'gameable/host/features';

const loaded = await resolveFeatures(
  featuresOf(definition),
  clientFeatures({ characters: { headOffset: [0, 0.78, 0] } }),
);
const engine = await createEngine({
  canvas,
  modules: [...modules, ...loaded.flatMap((f) => f.modules)],
});
const bound = await bindFeatures(loaded, engine);
const characters = bound.get('characters') as CharacterBridge | undefined;
```

### A room's authority on a server

The server entry gives a headless engine an adapter that keeps a world record
instead of a scene, the `HostApi` its sandbox imports, and the game module that
ticks it.

```ts
import { createHeadlessEngine } from 'gameable/core/headless';
import { physics } from 'gameable/physics';
import {
  createDirectSandbox,
  createGameSlot,
  createServerAdapter,
  createServerHost,
  createServerLoop,
} from 'gameable/host/server';

const slot = createGameSlot();
const engine = await createHeadlessEngine({ manifest, modules: [physics(), slot.module] });
const adapter = createServerAdapter(engine.get('physics'));
const host = createServerHost(engine.get('physics'), engine.assets, adapter, { seed: 7 });
const sandbox = createDirectSandbox({ mode: 'direct', game, host });
await slot.attach(createServerLoop(engine, sandbox, adapter, inputs, { seed: 7 }), engine.ctx);
engine.start();
```

## API

- **`createSandbox(options)`** — `{ mode: 'direct', game, host }` or
  `{ mode: 'wasm', guestModuleUrl | instantiate, getCoreModule, host, wasi? }`.
  Returns a `Sandbox`: `init`, `tick`, `shutdown`, `snapshot`, `restore`,
  `dead`, `error`. `createDirectSandbox` is the synchronous direct-mode form.
- **`EngineAdapter`** — one method per command, plus `setCamera`, `setHud` and
  `applyTransforms(f32, count)`. `NullEngineAdapter()` records calls instead.
- **`createEngineAdapter(engine, { modules, characters? })`** — the real
  adapter, over an `gameable/core` `Engine`. It owns the entity-to-`Object3D`
  mapping and the previous/current transform pairs the renderer interpolates
  between, resolves assets to splats and glTF scenes, and draws a placeholder
  mesh the shape of an entity's physics body until a model exists. Host modules
  are reached through `engine.get(...)`, so this package has no runtime
  dependency on `gameable/physics`, `audio`, `input` or `splat`; leave
  one out and the matching commands are ignored with one warning.
  `adapter.update(dt, alpha)` is one rendered frame: interpolation, then the
  character bridge.
- **`createCharacterBridge(options)`**, from the separate entry point
  **`gameable/host/characters`** — turns the six `spawn-character`
  commands into a character per entity: a skinned glTF, a Gameable studio
  export (`aosrig-splat`), or a GNM splat head, each with an `Animator`. It is not exported from the index because it is the one file that
  imports `gameable/character`, `gameable/animation` and `gameable/splat`
  at runtime; the adapter names only the `CharacterBridge` type, so a game that
  never imports this module ships none of them. Options: `engine`, `renderer`,
  `scene`, `capacityPerCharacter`, `headOffset`, `headHeight`, `decoders`,
  `extras` (an export's optional parts: `mouth`, `corrective`, `sharedClips`,
  `keepSharedFiles`), `fetch`, `loadGltf`, `shadows`, `speech`, `onLoadFailed`,
  `warn`, `log`. The bridge also has `upgrade(entity, src, { fadeMs })` (a fuller
  copy of an exported character swapped in), `shadows` and `entryOf(entity)`
  (with `mouth`, `corrective` and `hiddenPoints` for an export). Degrades to
  placeholders with one warning on the WebGL fallback, and never throws.
- **`clientFeatures(overrides?)`**, from **`gameable/host/features`** —
  the browser's `FeatureTable` for `resolveFeatures`. Today it has one entry,
  `characters`, which loads the bridge and binds it to the booted engine; on a
  headless engine its `bind` throws a `FeatureError`. `overrides.characters` is
  any bridge option except `engine`, `renderer` and `scene`.
- **`gameable/host/server`** — `createServerAdapter(physics, options?)`
  (an `EngineAdapter` over a `WorldRecord` and a `BodyTable`, no scene),
  `createServerHost(physics, assets, adapter, options?)` (the authority's
  `HostApi`), `createServerLoop(engine, sandbox, adapter, inputs, options?)`
  (the `game` module on a headless engine; `net.role` is always `authority`),
  plus `TransientCommands`, `WorldRecord` (with its `EntityTable` base), the
  snapshot types, and the root's
  three-free `createDirectSandbox`, `createSandbox`, `createGameSlot` and
  `applyOutput`, so a server imports nothing else from this package.
- **`createEngineHost(engine, adapter, options?)`** — the browser `HostApi`:
  `raycast`, `raycastBatch` and `overlapSphere` over the physics module, plus
  the manifest lookups. `filter.excludeEntity` is honoured by re-casting past
  the unwanted hit.
- **`createHostLoop(engine, sandbox, adapter, options?)`** — the `game`
  `EngineModule`, at order **-50**: after input, before physics, so the commands
  a tick emits are simulated by the step that follows rather than the next one.
  One fixed step is one guest tick: commit transforms, read input and contacts,
  encode, `tick`, `applyOutput`. The post-step body rows arrive separately, on
  the `physics:stepped` event, and go straight onto the entities they drive
  through `adapter.applyBodyRows` — no boundary crossing. Its `update` hands the
  interpolation factor to the adapter. A dead sandbox stops the loop and raises
  an overlay.
- **`createGameSlot(order?)`** — books the game module's place in the module
  order, because `createEngine` wants its list before the engine exists and the
  game module wants the engine. `slot.attach(loop, engine.ctx)` fills it in.
- **`createDomHud(options?)`** — the default HUD renderer: `{ text, bars,
crosshair, message }` into an overlay `div`, diffed, with no DOM work on an
  unchanged frame.
- **`applyOutput(adapter, out)` / `applyCommand(adapter, command)`** — dispatch
  a `frame-output`. The command switch is exhaustive over the WIT variant.
- **`createInputEncoder(maxBodies)`** — builds `frame-input` from engine state
  with pooled objects. `frame` becomes a `BigInt` here; everything else is
  written into preallocated storage.
- **`hostBindings(host)`** — `HostApi` to the jco import object, with the
  unversioned keys jco expects.
- **`minimalWasi(options)`** — the 18 `wasi:*` interfaces a componentize-qjs
  guest imports, with a real stderr stream so guest traps are visible.
- **`quantizeInput(input)`** — rounds the `f32` fields of a `frame-input`.
  Direct mode applies it automatically.

## Gotchas

- **Import-object keys are unversioned.** The guest imports
  `'gameable:engine/env@0.2.0'`; the host supplies `imports['gameable:engine/env']`.
  There is no `--map`.
- **`u64` is a `bigint` on the host and a `number` in the guest.** `frame` and
  `seed` must be `BigInt`s on the way in; `env.seed()` must return a `bigint`.
- **A guest trap permanently poisons the component instance.** Every later call
  fails with `cannot enter component instance`, so the sandbox latches `dead`
  and the host must build a new one rather than retry.
- **`direct` and `wasm` must produce identical hashes**; the parity test in
  `tests/boundary/` enforces it. That is why direct mode rounds its floats.
- **Host imports are synchronous only for `physics-query`.** Everything else is
  a command in `frame-output`.
- **`createEngineAdapter` needs the booted engine, and `createEngine` needs the
  module list.** Use `createGameSlot()` to break the cycle; registering a module
  after `initAll` is refused.
- **The character bridge is a subpath import, and that is deliberate.** Reaching
  it as `gameable/host/characters` is what keeps `onnxruntime-web` out of
  a game that has no characters. Import it dynamically as well and it lands in
  its own chunk.
- **Input edges are consumed per fixed step, not per rendered frame.** The host
  loop reads `pressed` / `released` after `gameable/input`'s own `fixedUpdate`
  (order `-100`) has published them; if the input service came from somewhere
  that is not a registered module, the loop calls `consume()` itself.
- **Placeholder meshes are lit.** They emit a quarter of their albedo so a
  scene with no lights still shows something, but add a light before deciding
  the colours are wrong.
- **The server entry is three-free; the package index is not.** The index
  re-exports `engineAdapter.ts`, which imports `three/webgpu`. A server takes
  `createDirectSandbox`, `createSandbox`, `createGameSlot` and `applyOutput`
  from `gameable/host/server`, which carries them, and never imports
  `gameable/host` itself. Take the engine from `gameable/core/headless`,
  never from the `gameable/core` root.
- **The world record only marks real changes.** A command that sets a field to
  the value it already holds (a `set-anim` sent every step) leaves `serial`
  where it was. Material parameters, expressions, look-at and clip weights are
  kept on the record's `visual` (so a late joiner's snapshot carries them), not
  in `adapter.transient`, which holds only lines, sounds, the listener and
  preloads. `world.spawned` and `world.despawned` list this tick's arrivals and
  departures and are emptied by `beginTick()`.
- **Characters need the bridge.** Without `createCharacterBridge`,
  `spawn-character` and the rest warn once each and do nothing. Capsules stand in.
- **The boundary tests are gated.** They build a real component, so the root
  `npm test` skips them. Run them with:

  ```sh
  GAMEABLE_BOUNDARY=1 npx vitest run -c tests/boundary/vitest.config.ts
  ```
