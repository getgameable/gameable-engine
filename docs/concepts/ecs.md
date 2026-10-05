# ECS and game code

bitecs 0.4 is the ECS and it lives **inside the guest**. The host owns
rendering, physics, input, audio, assets and characters; the guest owns
entities, components and systems. `gameable` is the only import game code
needs.

## A game is one declaration

```ts
import { defineGame, prefab, Enemy, Health } from 'gameable';

const Player = prefab({
  body: { shape: 'capsule', dims: [0.3, 0.9], kind: 'character', mass: 80 },
  health: 100,
});

const Grunt = prefab({
  asset: 'enemy-capsule',
  body: { shape: 'capsule', dims: [0.3, 0.9], kind: 'dynamic', mass: 60 },
  health: 30,
  components: [Enemy],
});

export default defineGame({
  assets: ['arena', 'enemy-capsule', 'shot'],
  world: { gravity: -9.81, maxEntities: 512 },
  player: { prefab: Player, spawn: [0, 1, 0], camera: 'firstPerson', eyeHeight: 1.7 },
  spawns: [{ prefab: Grunt, position: [0, 1, -6] }],
  rules: { walkSpeed: 4, damage: 10 },
  systems: [movePlayer, shoot, updateHud],
});
```

`assets`, `world`, `player` and `spawns` are sugar over built-in systems, so
two games that declare the same thing behave identically. `rules` is handed
straight back as `ctx.rules`. Anything the declarative layer cannot express is
a plain system.

## Tick order

Fixed, because determinism depends on it:

1. decode `frame-input` into preallocated storage, and apply `player-joined`
   / `player-left` (a room's authority spawns or despawns `player` for that
   player)
2. ingest rigid-body transforms (stride 15) into `Transform` and `Velocity`,
   to read — the host drew them itself when it stepped, so they are not packed
   back out
3. built-in look accumulator (`input.mouse.dx/dy` → `camera.look`)
4. built-in velocity integration, for entities with `Velocity` and no
   `RigidBody` — this is where `world.gravity` applies
5. your `systems[]` that run where this guest runs, in declaration order
6. your `update()`
7. built-in camera rig, from `player.camera`
8. pack `frame-output.transforms` and the command list

Each user system is wrapped: a throw is logged and the frame still returns a
valid output. Eight consecutive failing ticks mark the guest `dead` and the
host rebuilds the sandbox.

## Systems

A system is a plain function of the frame context:

```ts
import type { GameContext } from 'gameable';

// Reused across frames: a system must not allocate.
const eye = { x: 0, y: 0, z: 0 };

function shoot(ctx: GameContext): void {
  if (!ctx.input.mousePressed(1)) return;
  eye.x = Transform.x[ctx.player];
  eye.y = Transform.y[ctx.player] + 1.7;
  eye.z = Transform.z[ctx.player];
  const hit = ctx.physics.raycast(eye, forward, 100, undefined, ctx.player);
  if (hit) Health.current[hit.entity] -= 10;
}
```

`ctx` carries `world`, `frame`, `dt`, `elapsed`, `rng`, `contacts`, `events`,
`player`, `rules`, `config`, the `spawn` / `despawn` / `assetId` helpers, and
the facades. It is the same object every frame, mutated in place — read it, do
not retain it.

## Built-in components

Structure-of-arrays: `Transform.x[entity]`, never `Transform[entity].x`. Every
array is preallocated to `world.maxEntities` (default 4096), so writing one
never allocates.

| Component    | Lanes                              |
| ------------ | ---------------------------------- |
| `Transform`  | `x y z`, `qx qy qz qw`, `sx sy sz` |
| `Renderable` | `asset`, `flags`, `dirty`          |
| `RigidBody`  | `handle`, `kind`, `shape`, `dirty` |
| `Character`  | `bundle`, `dirty`                  |
| `Velocity`   | `x y z`, `ax ay az`                |
| `Health`     | `current`, `max`                   |

plus the tags `Player`, `Enemy` and `Pickup`. `createWorld`, `addEntity`,
`removeEntity`, `addComponent`, `removeComponent`, `hasComponent`, `query`,
`Not`, `Or` and `And` are re-exported from bitecs unchanged, so your own
components work exactly as bitecs documents.

### Writing `Transform` by hand

`spawn` and the built-in velocity integration tell the packer which entities
moved. Nothing watches the arrays themselves, so a system that writes a lane
directly has to say so — otherwise the row is never packed and the host never
moves the object:

```ts
import { Transform, TRANSFORM_FLAGS, markMoved } from 'gameable';

function bob(ctx: GameContext): void {
  Transform.y[ctx.player] = 1 + Math.sin(ctx.elapsed);
  markMoved(ctx.player, TRANSFORM_FLAGS.POSITION);
}
```

`markMoved(entity)` with no flags marks position, rotation and scale. Flags
accumulate until the end of the tick, so marking twice costs nothing.

Body ingestion is the deliberate exception: it fills `Transform` and `Velocity`
for a physics-driven entity but marks nothing, because the host already moved
that object from the body's own row. Read those lanes freely; to _move_ the
entity, send `physics.teleport` or `physics.setVelocity` rather than writing
the lane, or the body will simply put it back next step.

## Prefabs mint the ids

Every handle is minted by the **guest**, so the host never has to hand one
back. `prefab()` is pure and safe at module scope; `spawn()` allocates the
entity id from bitecs, the body id from a counter that starts at 1, writes the
built-in components, and queues the `spawn` / `add-body` / `spawn-character`
commands the host needs.

```ts
const crate = ctx.spawn(Crate, { x: 0, y: 2, z: -5 });
ctx.despawn(crate); // emits remove-body then despawn
```

## Zero allocation, and why it matters

Systems run 60+ times a second inside a QuickJS heap with a simple collector. A
steady-state tick in Gameable Engine allocates nothing:

- `frame-output.transforms` is a preallocated `Float32Array`, returned as a
  memoised subarray — the same row count returns the same object every frame.
- Commands are pooled per tag and mutated in place; `commandPoolSize()` stops
  growing once a game reaches its steady state, and a test asserts it.
- `input.axis2(...)` and `input.mouse` return pooled objects.
- `hud.set(model)` shallow-compares against the previous model and only calls
  `JSON.stringify` on a real change.

Follow the same rule in your own systems: hoist your vectors, hoist your query
term arrays, and mutate.

## Snapshot and restore

`snapshot()` serialises the built-in component arrays, the entity id space, the
SDK counters and the RNG state into a versioned little-endian byte string.
Custom components are not covered automatically — return them from
`defineGame({ snapshot })` and read them back in `defineGame({ restore })`, and
they are JSON-encoded into the snapshot header.

Restore rebuilds the entity id space exactly, so a run resumed from a snapshot
produces the same frames as the run it was taken from. The determinism test
relies on it.

## See also

- [The wasm boundary](./wasm-boundary.md)
- [Write a game system](../recipes/write-a-game-system.md)
- `packages/sdk/README.md` — gameable
- [Build your first FPS](../start/02-first-fps.md)
