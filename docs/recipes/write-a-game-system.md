# Write a game system

## Goal

Your game runs one more function every fixed step, with access to input,
physics, the ECS and the HUD — and it allocates nothing while doing it.

## Files you will edit

- `src/systems/patrol.ts`
- `src/game.ts`

## Steps

1. Write the system. It is a plain function of the frame context. Hoist every
   object it needs, because this runs 60 times a second.

   ```ts
   // src/systems/patrol.ts
   import { Enemy, Transform, Velocity, query, type GameContext } from 'gameable';

   /** Hoisted: a query term array allocated per frame is a per-frame allocation. */
   const ENEMIES = [Enemy, Transform, Velocity];

   /** Metres per second an enemy patrols at. */
   const SPEED = 1.5;

   /**
    * Walk every enemy back and forth along Z, turning every four seconds.
    *
    * @param ctx The frame context.
    * @returns Nothing.
    */
   export function patrol(ctx: GameContext): void {
     const forward = Math.floor(ctx.elapsed / 4) % 2 === 0 ? 1 : -1;
     const entities = query(ctx.world, ENEMIES);
     for (let i = 0; i < entities.length; i += 1) {
       const e = entities[i];
       Velocity.z[e] = SPEED * forward;
       ctx.physics.moveCharacter(e, 0, 0, Velocity.z[e]);
     }
   }
   ```

2. Register it. Systems run in declaration order, after the built-ins and
   before `update()`.

   ```diff
   // src/game.ts
   +import { patrol } from './systems/patrol.ts';

    export default defineGame({
      player: { prefab: Player, spawn: [0, 1, 0], camera: 'firstPerson' },
   -  systems: [movePlayer, shoot],
   +  systems: [movePlayer, shoot, patrol],
    });
   ```

3. Prove it moves something, with a test rather than by looking at it.

   ```ts
   // src/systems/patrol.test.ts
   import { expect, it } from 'vitest';
   import { createGuest, Transform } from 'gameable';
   import { createGameConfig, createMockHost, simulate } from 'gameable/test';
   import game from '../game.ts';

   it('moves enemies along Z', () => {
     const guest = createGuest(createMockHost(), game);
     guest.init(createGameConfig());
     const before = Transform.z[2];
     simulate(guest, { frames: 60 });
     expect(Transform.z[2]).not.toBe(before);
   });
   ```

## Verify

```sh
npm test
```

The new test passes, and so does the zero-allocation assertion in
`packages/sdk/src/packing.test.ts`: your system must not make the pooled
command count grow after the first few frames. If it does, you allocated
something in the loop — usually a query term array, a vector literal, or a
`.map()`.

## See also

- [ECS and game code](../concepts/ecs.md)
- [The wasm boundary](../concepts/wasm-boundary.md)
- [Build the wasm guest](./build-the-wasm-guest.md)
- `packages/sdk/README.md` — gameable
