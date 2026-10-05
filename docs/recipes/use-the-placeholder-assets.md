# Use the placeholder assets

## Goal

Your game renders the placeholder arena, puts the player and six enemies on its
spawn points, and fires a sound — with no content of your own and no asset paths
anywhere in game code.

## Files you will edit

- `src/main.ts`
- `src/game.ts`

## Steps

1. Merge the pack into the manifest in `src/main.ts`. The package ships its own
   entries and its own `baseUrl`, so the ids `env.arena` and `sfx.*` become
   available without a single path appearing in your game.

   ```ts
   import { parseManifest } from 'gameable/assets';
   import { arenaSpawns, PLACEHOLDER_ASSETS_BASE, placeholderManifest } from 'gameable/placeholder';
   import { createEngine } from 'gameable/core';

   const manifest = parseManifest(
     { ...placeholderManifest, baseUrl: PLACEHOLDER_ASSETS_BASE },
     { baseUrl: PLACEHOLDER_ASSETS_BASE },
   );

   const engine = await createEngine({
     canvas: document.querySelector('canvas')!,
     manifest,
     // The spawn table is data, not an asset: hand it to the guest as config.
     config: { spawns: arenaSpawns },
   });

   await engine.assets.preload('world');
   await engine.start();
   ```

2. Use the ids and the spawn points from `src/game.ts`. Spawn coordinates arrive
   as plain numbers through `ctx.config`, so the guest never imports the package
   and never sees a URL.

   ```ts
   import type { GameContext } from 'gameable';

   // Set in init, not at module scope: Wizer freezes module state into the
   // binary, so a handle taken at import time would be the same every run.
   let arena = 0;

   export function init(ctx: GameContext): void {
     arena = ctx.assets.resolve('env.arena');
     ctx.spawnWorld(arena);

     const { player, enemies } = ctx.config.spawns;
     ctx.spawnPlayer(player.position, player.yaw);
     for (const enemy of enemies) ctx.spawnEnemy(enemy.position, enemy.yaw);
   }

   export function fire(ctx: GameContext): void {
     // By id, never by path: the registry is the only thing that knows a URL.
     ctx.audio.play('sfx.shot', { bus: 'sfx', volume: 0.7 });
   }
   ```

## Verify

```sh
npm run dev
```

You start at `[0, 0, 9]` looking down `-Z` at a 24 x 24 m checkered floor ringed
by four 3 m walls, with six pillars, a crate and a ramp between you and the far
wall, and six capsules standing on the perimeter. Firing plays a short crack.

Then assert it headlessly:

```sh
npm test
```

```ts
expect(harness.commands('spawn-world')).toContainEqual(
  expect.objectContaining({ asset: 'env.arena' }),
);
expect(harness.commands('spawn-enemy')).toHaveLength(6);
```

## See also

- [Assets and the manifest](../concepts/assets.md)
- [Play a sound](./play-a-sound.md)
- `packages/assets-placeholder/README.md` — gameable/placeholder
