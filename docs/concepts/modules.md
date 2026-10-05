# Engine modules

Every host subsystem is an `EngineModule`:

```ts
import type { EngineModule, HostContext } from 'gameable/core';

/** What other modules and game code get from `engine.get('spin')`. */
interface SpinService {
  /** Radians turned so far. */
  angle: number;
}

/**
 * A module that just turns.
 *
 * @returns The module, ready to pass to `createEngine`.
 */
export function spin(): EngineModule {
  const service: SpinService = { angle: 0 };
  return {
    id: 'spin',
    order: 100,
    init: (ctx: HostContext) => {
      console.log(ctx.caps.webgpu);
      return service; // published as engine.get('spin')
    },
    fixedUpdate: (dt) => {
      service.angle += dt;
    },
    dispose: () => {
      service.angle = 0;
    },
  };
}
```

`createEngine({ modules: [input(), physics(), audio(), splat()] })` registers
them; the engine drives them. A module owns its own resources and releases them
in `dispose`; the engine never reaches inside one.

`init(ctx: HostContext)` gets the assets, events, clock, config, capabilities
and the service registry — no scene, camera or renderer, because the same
module list can boot a headless engine (`createHeadlessEngine` from
`gameable/core/headless`, a multiplayer room's authority), where none of
those exist. A module that draws asks for them by name:

```ts
import { requireRenderContext, type EngineModule } from 'gameable/core';

export const sky: EngineModule = {
  id: 'sky',
  init: (host) => {
    const ctx = requireRenderContext(host, 'sky'); // throws a ModuleError when headless
    ctx.scene.add(ctx.camera);
  },
  dispose: () => undefined,
};
```

## Order

Modules run sorted by `order` (default `0`), then by registration order.
`init` runs in that order, `dispose` in reverse. Rough convention:

| `order` | Who                                       |
| ------- | ----------------------------------------- |
| `-100`  | input                                     |
| `-50`   | gameplay, the wasm sandbox                |
| `0`     | physics                                   |
| `200`   | rendering helpers, splats, overlays       |

Gameplay runs **before** physics on purpose, so that the commands a guest tick
emits are simulated by the step that follows rather than the next one. See
[the engine loop](./engine-loop.md#who-runs-when-inside-a-fixed-step).

Because `init` is awaited one module at a time, a module may call
`ctx.get('physics')` for anything registered ahead of it.

## Services and declaration merging

A module publishes a service by returning it from `init`, or by calling
`ctx.registerService(id, service)`. `engine.get(id)` is typed through the
`EngineServices` interface, which core deliberately leaves **empty**. Each
package merges its own entry in:

```ts
import type { PhysicsService } from './service.js';

declare module 'gameable/core' {
  interface EngineServices {
    physics: PhysicsService;
  }
}
```

Importing the package is then enough for `engine.get('physics')` to be typed —
no cast at the call site, and core never has to know the package exists. The
same pattern extends `EngineEventMap` for typed events.

## Per-frame hooks

All optional; a module is only called for the hooks it implements.

| Hook                | When                                    |
| ------------------- | --------------------------------------- |
| `beginFrame()`      | Before the frame's fixed steps          |
| `fixedUpdate(dt)`   | Once per fixed step, `dt` always `1/60` |
| `update(dt, alpha)` | Once per frame, before rendering        |
| `endFrame()`        | After rendering                         |

None of them may allocate.

## Features: what a game declares

A game says which optional modules it needs in its definition:
`defineGame({ features: { characters: true } })`. `featuresOf(definition)` turns
that into a table of names and options, and `resolveFeatures` looks each name up
in the host's table of loaders, then `bindFeatures` runs the ones that need the
booted engine. A feature is an explicit factory behind a dynamic import, never a
side-effect import, so a feature nobody declared is never downloaded.

There is one table per side. The page's is `clientFeatures()` from
`gameable/host/features`; a server table comes with multiplayer. The page
imports the game definition in both modes, direct and wasm, only to read its
`features`. See [Turn on a feature](../recipes/turn-on-a-feature.md).

## See also

- [The engine loop](./engine-loop.md)
- [Assets and the manifest](./assets.md)
- [Create an engine](../recipes/create-an-engine.md)
- `packages/core/README.md` — gameable/core
