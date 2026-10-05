# Add a weapon

## Goal

The right mouse button fires a shotgun: five pellets in a cone, a slower fire
rate, its own ammunition, and its own sound. The rifle on the left button keeps
working.

## Files you will edit

- `src/systems/shotgun.ts`
- `src/game.ts`

## Steps

1. Write the system. Five rays in one `raycastBatch` rather than five
   `raycast` calls, because each call is a full round trip across the wasm
   boundary; and every object it needs is hoisted, because this runs sixty
   times a second.

   ```ts
   // src/systems/shotgun.ts
   import {
     Health,
     MOUSE_BUTTONS,
     Transform,
     type CollisionLayers,
     type GameContext,
     type QueryFilter,
     type RayQuery,
   } from 'gameable';

   import { EYE_OFFSET } from '../prefabs';

   /** Pellets per shot. */
   const PELLETS = 5;

   /** Half-angle of the cone, radians. */
   const SPREAD = 0.06;

   /** Mutable state; `resetShotgun` puts it back. */
   export const shotgunState = { shells: 6, cooldown: 0 };

   /** What a pellet may hit. The player's own capsule is not on these layers. */
   const LAYERS: CollisionLayers = Object.freeze({ enemy: true, staticGeometry: true });
   const FILTER: QueryFilter = Object.freeze({ layers: LAYERS, solidOnly: true });

   /** One `RayQuery` per pellet, built once and mutated in place. */
   const rays: RayQuery[] = Array.from({ length: PELLETS }, () => ({
     origin: { x: 0, y: 0, z: 0 },
     direction: { x: 0, y: 0, z: -1 },
     maxDistance: 25,
     filter: FILTER,
   }));

   /**
    * Reload the shotgun. Call it from `defineGame({ init })`.
    *
    * @returns Nothing.
    */
   export function resetShotgun(): void {
     shotgunState.shells = 6;
     shotgunState.cooldown = 0;
   }

   /**
    * Fire a spread of pellets on the right mouse button.
    *
    * @param ctx The frame context.
    * @returns Nothing.
    */
   export function shotgun(ctx: GameContext): void {
     if (shotgunState.cooldown > 0) shotgunState.cooldown -= ctx.dt;
     if (!ctx.input.mousePressed(MOUSE_BUTTONS.RIGHT)) return;
     if (shotgunState.cooldown > 0 || shotgunState.shells <= 0) return;

     shotgunState.shells -= 1;
     shotgunState.cooldown = Number(ctx.rules.shotgunInterval ?? 0.8);
     ctx.audio.play('sfx.shot', { entity: ctx.player, volume: 1 });

     const player = ctx.player;
     const yaw = ctx.camera.look.yaw;
     const pitch = ctx.camera.look.pitch;
     for (let i = 0; i < PELLETS; i += 1) {
       const ray = rays[i];
       // Deterministic spread: `ctx.rng`, never `Math.random`.
       const dYaw = yaw + (ctx.rng.float() - 0.5) * SPREAD * 2;
       const dPitch = pitch + (ctx.rng.float() - 0.5) * SPREAD * 2;
       const cosPitch = Math.cos(dPitch);
       ray.origin.x = Transform.x[player];
       ray.origin.y = Transform.y[player] + EYE_OFFSET;
       ray.origin.z = Transform.z[player];
       ray.direction.x = -Math.sin(dYaw) * cosPitch;
       ray.direction.y = Math.sin(dPitch);
       ray.direction.z = -Math.cos(dYaw) * cosPitch;
     }

     const damage = Number(ctx.rules.shotgunDamage ?? 9);
     const hits = ctx.physics.raycastBatch(rays);
     for (const hit of hits) {
       if (!hit) continue;
       const target = hit.entity;
       if (target === 0 || (Health.max[target] ?? 0) <= 0) continue;
       Health.current[target] = (Health.current[target] ?? 0) - damage;
       ctx.audio.play('sfx.hit', { entity: target, volume: 0.8 });
     }
   }
   ```

2. Register it, and give it its numbers. Systems run in declaration order,
   after the built-ins.

   ```diff
   // src/game.ts
   +import { resetShotgun, shotgun } from './systems/shotgun';

    export default defineGame({
      rules: {
        walkSpeed: 5,
   +    shotgunDamage: 9,
   +    shotgunInterval: 0.8,
      },
      init: (ctx) => {
        resetWeapon(ctx);
   +    resetShotgun();
      },
   -  systems: [movePlayer, weapon, enemyAI, pickups, updateHud],
   +  systems: [movePlayer, weapon, shotgun, enemyAI, pickups, updateHud],
    });
   ```

## Verify

```sh
npm run dev
```

Right-click an enemy at close range: it should die in two shells where the
rifle takes two hits. Then check the numbers rather than your eyes — add this
to `tests/game.test.ts`:

```ts
it('the shotgun hits with every pellet at point-blank range', () => {
  const harness = boot();
  const target = livingEnemies(harness.guest)[0];
  scriptedHit = {
    body: RigidBody.handle[target] ?? 0,
    entity: target,
    point: { x: 0, y: 1, z: -2 },
    normal: { x: 0, y: 0, z: 1 },
    distance: 2,
  };
  pressMouse(harness.input, 2); // MOUSE_BUTTONS.RIGHT
  harness.step(1);
  expect(Health.current[target]).toBe(40 - 9 * 5);
});
```

`npm test` must stay green, including the determinism test — if it fails, you
used `Math.random()` somewhere instead of `ctx.rng`.

## See also

- [Write a game system](./write-a-game-system.md)
- [Add an enemy](./add-an-enemy.md)
- [ECS and game code](../concepts/ecs.md)
- `packages/sdk/README.md` — gameable
