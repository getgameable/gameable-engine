# Change the level

## Goal

The game renders your own gaussian-splat environment, collides with your own
collision mesh, and spawns the player, the enemies and the pickups where you
want them.

## Files you will edit

- `src/assets.json`
- `src/arena.ts`

## Steps

1. Point the manifest at your world. Drop the files in `public/` — Vite copies
   that directory verbatim — and give them ids. The id is the contract; game
   code never sees a path.

   ```diff
   // src/assets.json
    {
      "version": 1,
      "baseUrl": "/",
      "assets": [
        {
          "id": "env.arena",
          "type": "splat",
   -      "src": "@placeholder/arena.spz",
   +      "src": "/levels/foundry.spz",
          "tags": ["world"],
   -      "collider": { "shape": "mesh", "src": "@placeholder/arena.collider.bin", "layer": "static" }
   +      "collider": { "shape": "mesh", "src": "/levels/foundry.collider.bin", "layer": "static" }
        },
   ```

   `@placeholder/...` is a template convention: `src/main.ts` maps those onto
   the files inside `gameable/placeholder`. Anything else is resolved
   against `baseUrl`, so `/levels/foundry.spz` means `public/levels/foundry.spz`.

   SPZ loads about four times faster than PLY; prefer it. The collider is a
   separate baked triangle mesh, because a splat has no geometry a solver can
   use — `parseCollider` in `gameable/placeholder` documents the
   format, and `src/main.ts` is where it is turned into a static body.

2. Move the spawn points. Every `position` is on the floor, in metres, Y-up,
   with `yaw` in radians about `+Y` (`0` looks down `-Z`); the prefab's own
   half-height is added when it spawns.

   ```diff
   // src/arena.ts
    export const arenaSpawns: ArenaSpawns = {
   -  bounds: { min: [-12, 0, -12], max: [12, 3, 12] },
   -  player: { position: [0, 0, 9], yaw: 0 },
   +  bounds: { min: [-20, 0, -14], max: [20, 6, 14] },
   +  player: { position: [-17, 0, 0], yaw: 1.5708 },
      enemies: [
   -    { position: [-9.5, 0, -9.5], yaw: -2.3562 },
   +    { position: [12, 0, -6], yaw: 3.1416 },
   +    { position: [12, 0, 6], yaw: 3.1416 },
   +    { position: [0, 0, 0], yaw: 3.1416 },
      ],
      pickups: [
   -    { position: [0, 1, 0], yaw: 0 },
   +    { position: [-4, 1, 8], yaw: 0 },
      ],
    };
   ```

   The loops in `src/game.ts`'s `init` walk these lists, so adding or removing
   an entry changes how many things exist. Nothing else needs to know.

## Verify

```sh
npm test
```

The template ships one test asserting that `src/arena.ts` matches the
placeholder pack's own spawn table; delete it once the level is yours, and
replace it with one that matters — that every spawn point is inside `bounds`,
for example. Then:

```sh
npm run dev
```

Walk to each spawn point. You should land on the floor rather than falling
through it or standing in the air: if you fall, the collider and the splat
disagree about where the floor is, and the collider is what to fix.

## See also

- [Assets and the manifest](../concepts/assets.md)
- [Load a splat environment](./load-a-splat-environment.md)
- [Use the placeholder assets](./use-the-placeholder-assets.md)
- `packages/splat/README.md` — gameable/splat
