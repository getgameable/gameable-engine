# Load a splat environment

## Goal

Your game world is a gaussian splat capture instead of an empty scene: it loads by id from the
manifest, appears when the game starts, and draws behind everything else in the right order.

## Files you will edit

- `assets.json`
- `src/game.ts`

## Steps

1. Declare the capture in `assets.json`. The id is the contract; the path is the host's
   business and never appears in game code. SPZ is the format to prefer — it is roughly a
   third the size of the equivalent PLY and decodes faster — but `.ply`, `.splat` and
   `.ksplat` all work, and the loader picks the decoder from the extension.

   ```json
   {
     "version": 1,
     "baseUrl": "/assets/",
     "assets": [
       { "id": "arena", "type": "splat", "src": "worlds/arena.spz", "tags": ["world"] },
       {
         "id": "arena-collider",
         "type": "gltf",
         "src": "worlds/arena-collider.glb",
         "tags": ["world"]
       }
     ]
   }
   ```

   A splat has no collision — it is a cloud of translucent ellipsoids, not a surface — so ship
   a low-poly collider mesh next to it and give physics that. The pair is what makes a splat
   world walkable.

2. Put it in the scene on startup. `preload` fetches everything tagged `world`, and the splat
   module's service adds the object with the right draw order already set.

   ```ts
   import { defineGame } from 'gameable';

   export default defineGame({
     assets: 'assets.json',

     async init(ctx) {
       await ctx.assets.preload('world');
       ctx.engine.get('splat').add('arena');
     },
   });
   ```

   Registering the `splat` asset type is the `splat()` module's job, and the FPS and
   third-person templates already list it in `createEngine({ modules })`. If you started from
   a bare `createEngine` call, add it:

   ```ts
   import { splat } from 'gameable/splat';

   const engine = await createEngine({ canvas, manifest: 'assets.json', modules: [splat()] });
   ```

3. Place it. A capture's origin is wherever the photogrammetry decided, which is rarely your
   world origin, and its scale is whatever the capture's metric scale was.

   ```ts
   const world = ctx.engine.get('splat').add('arena');
   world.position.set(0, -1.2, 0);
   world.rotation.y = Math.PI / 2;
   ```

   Move the collider by the same transform, or the player will walk through the floor they can
   see.

## Verify

```sh
npm run dev
```

The world is there and holds still as you look around; there is no popping or flickering as
the camera turns, and the overlay (`F3`) shows one draw call for it. Then assert it
headlessly:

```sh
npm test
```

```ts
const asset = await loadSplat('/assets/worlds/arena.spz');
expect(asset.count).toBeGreaterThan(0);
expect(asset.format).toBe('spz');
```

If the world renders as a grey fog, the capture's covariances are in the wrong units — check
it in the viewer with `npm run dev -w examples/splat-viewer` first. If it renders but
flickers against a window or a water plane, that is the draw-order rule: transparent meshes
must not intersect splat volumes.

## See also

- [Gaussian splats](../concepts/splats.md)
- [Assets and the manifest](../concepts/assets.md)
- `packages/splat/README.md` — gameable/splat
