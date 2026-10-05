# Add an enemy

## Goal

A second kind of enemy — a heavy: slower, twice the health, hits harder, and a
different colour — sharing the existing chase-and-attack behaviour.

## Files you will edit

- `src/prefabs.ts`
- `src/game.ts`

## Steps

1. Declare what a heavy is made of. A prefab is pure and safe at module scope;
   nothing is resolved until it is spawned.

   ```ts
   // src/prefabs.ts
   /** A heavy: bigger, slower, and it takes four rifle magazines to notice. */
   export const HeavyPrefab = prefab({
     name: 'heavy',
     body: {
       shape: 'capsule',
       dims: [0.5, 0.9],
       kind: 'character',
       mass: 140,
       layer: { enemy: true },
       mask: { staticGeometry: true, player: true, enemy: true },
       flags: { reportContacts: true, noSleep: true },
     },
     health: 120,
     components: [Enemy],
   });

   /** Height of a heavy capsule's centre above its feet. */
   export const HEAVY_CENTRE = 0.5 + 0.9;

   /** Heavy purple. */
   export const HEAVY_COLOUR: readonly [number, number, number] = [0.44, 0.2, 0.62];
   ```

   The placeholder mesh is drawn from the body, so the capsule on screen is
   exactly the capsule the solver uses. Changing `dims` changes both.

   `reportContacts` is off unless a body asks for it, and a heavy is exactly
   the kind of body that should ask: the game reacts when one touches the
   player. `begin` and `end` are all it gets — the per-step `stay` manifold is
   a separate, rarer opt-in, and nothing here needs it.

2. Spawn two of them, and let the existing AI drive them. `HeavyPrefab`
   carries the `Enemy` tag, so `enemyAI` already queries it and `updateHud`
   already counts it — nothing else has to change.

   ```diff
   // src/game.ts
   -import { EnemyPrefab, ENEMY_CENTRE, ENEMY_COLOUR, ... } from './prefabs';
   +import {
   +  EnemyPrefab,
   +  ENEMY_CENTRE,
   +  ENEMY_COLOUR,
   +  HeavyPrefab,
   +  HEAVY_CENTRE,
   +  HEAVY_COLOUR,
   +  ...
   +} from './prefabs';

    init: (ctx) => {
       for (const spawn of arenaSpawns.enemies) {
         at.x = spawn.position[0];
         at.y = spawn.position[1] + ENEMY_CENTRE;
         at.z = spawn.position[2];
         tint(ctx.spawn(EnemyPrefab, at), ENEMY_COLOUR[0], ENEMY_COLOUR[1], ENEMY_COLOUR[2]);
       }
   +
   +   // Two heavies, in the far corners.
   +   for (const spawn of [arenaSpawns.enemies[0], arenaSpawns.enemies[1]]) {
   +     at.x = spawn.position[0];
   +     at.y = spawn.position[1] + HEAVY_CENTRE;
   +     at.z = spawn.position[2] - 2;
   +     tint(ctx.spawn(HeavyPrefab, at), HEAVY_COLOUR[0], HEAVY_COLOUR[1], HEAVY_COLOUR[2]);
   +   }
    },
   ```

   To make heavies genuinely slower rather than merely tougher, give them their
   own speed in `enemyAI` — the state arrays there are indexed by entity id, so
   a `aiSpeed: Float32Array` written at spawn time is the natural place.

## Verify

```sh
npm test
```

The template's own test asserts six enemies; update it to eight and it should
pass again:

```ts
expect(livingEnemies(harness.guest)).toHaveLength(8);
```

Then `npm run dev`: the HUD should read `enemies 8` at the start, and the two
purple capsules should be visibly wider than the red ones and take five rifle
hits instead of two.

## See also

- [Add a weapon](./add-a-weapon.md)
- [Write a game system](./write-a-game-system.md)
- [Physics](../concepts/physics.md)
- `packages/sdk/README.md` — gameable
