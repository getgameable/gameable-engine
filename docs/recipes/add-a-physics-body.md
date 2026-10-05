# Add a physics body

## Goal

A crate that falls, lands on the level geometry, and can be shoved by shooting
it. When you are done, `npm run dev` shows a box that obeys gravity and reports
its collisions to your game code.

## Files you will edit

- `src/prefabs.ts`
- `src/game.ts`

## Steps

1. Declare the prefab. `prefab()` is pure, so it is safe at module scope — the
   Wizer snapshot captures nothing.

   ```ts
   // src/prefabs.ts
   import { prefab } from 'gameable';

   export const Crate = prefab({
     name: 'crate',
     asset: 'crate', // a manifest string id, never a URL
     body: {
       shape: 'box',
       dims: [0.5, 0.5, 0.5], // half extents, metres
       kind: 'dynamic',
       mass: 25,
       friction: 0.6,
       restitution: 0.1,
       layer: { debris: true },
       mask: { defaultLayer: true, staticGeometry: true, player: true, projectile: true },
       flags: { reportContacts: true },
     },
   });
   ```

   `layer` says what the crate **is**; `mask` says what it collides with. Both
   sides must agree — a body whose `mask` omits `debris` will pass straight
   through the crate however the crate is masked.

   `reportContacts` is what puts this crate's collisions in
   `frame-input.contacts`. It is **off by default**, and worth leaving off for
   scenery: a body that reports nothing costs nothing, and a level full of
   crates that all report is a contact stream nobody reads.

2. Spawn one in `init`. Preallocate the spawn position: `init` runs once, but the
   same habit is what keeps systems allocation-free.

   ```ts
   // src/game.ts
   import { defineGame, physics, spawn, Transform, type GameContext } from 'gameable';

   import { Crate } from './prefabs';

   const crateSpawn = { x: 0, y: 4, z: -6 };
   let crate = 0;

   export default defineGame({
     assets: ['arena', 'crate'],
     init() {
       crate = spawn(Crate, crateSpawn);
     },
     systems: [shoveCrate],
   });
   ```

3. Push it with a raycast. A hitscan shot is one synchronous query and one
   deferred impulse command; neither allocates in the steady state.

   ```ts
   // src/game.ts
   const SHOVE = 400; // newton-seconds

   function shoveCrate(ctx: GameContext): void {
     if (!ctx.input.pressed('Mouse0')) return;
     const hit = physics.raycast(
       ctx.camera.position,
       ctx.camera.forward,
       100,
       undefined,
       ctx.player,
     );
     if (hit === null || hit.entity !== crate) return;
     physics.applyImpulse(
       hit.entity,
       ctx.camera.forward.x * SHOVE,
       0,
       ctx.camera.forward.z * SHOVE,
     );
   }
   ```

4. Read the result. The host writes every non-static body's pose into the
   stride-15 body buffer each fixed step, and the SDK unpacks it into
   `Transform`, so the crate's position is already there. Read it freely; to
   _move_ the crate, send a command (`physics.teleport`) rather than writing
   `Transform.y[crate]`, because the body is the authority and the host draws
   it from the body's own row:

   ```ts
   // src/game.ts — inside a system
   if (Transform.y[crate] < -20) physics.teleport(crate, crateSpawn.x, crateSpawn.y, crateSpawn.z);
   ```

## Verify

```sh
npm run dev
```

The crate falls from four metres, lands on the floor and stops within about a
second. Shooting it slides it away from you; it never sinks through the floor and
never comes to rest below `y = 0`. In a test, assert the landing:

```ts
expect(Transform.y[crate]).toBeGreaterThan(0.4);
expect(Transform.y[crate]).toBeLessThan(0.6);
```

## See also

- [Physics](../concepts/physics.md)
- [Modules](../concepts/modules.md)
- `packages/physics-jolt/README.md` — gameable/physics
