# gameable/physics

## What

The physics `EngineModule`, backed by `jolt-physics` 1.1 compiled to wasm. Rigid
bodies, `CharacterVirtual` controllers, raycast / raycast-batch / overlap-sphere
queries, contact events and a wireframe debug view.

Body state comes back as a packed stride-15 `Float32Array` — the exact shape of
the WIT `frame-input.bodies` buffer — so the host never builds an object per body
per frame.

## When to use

Your game needs collision, gravity, a character controller or hitscan raycasts.
Register `physics()` in the engine module list and drive it with the physics
commands in `frame-output`.

Use `createPhysicsWorld` directly only in tools and tests: a headless collider
baker, a determinism harness, a benchmark.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

The wasm binary is a **separate file**. Under node it is found automatically; in
a browser build, hand the module the URL your bundler minted:

```ts
import wasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url';

physics({ wasmUrl });
```

## Minimal example

```ts
import { createEngine } from 'gameable/core';
import { physics } from 'gameable/physics';

const engine = await createEngine({
  canvas,
  manifest: '/assets/assets.json',
  modules: [physics({ gravity: [0, -9.81, 0] })],
});

const world = engine.get('physics');

// A static floor and a crate to drop onto it.
world.addBody({
  id: 1,
  shape: 'box',
  dims: [20, 0.5, 20],
  position: [0, -0.5, 0],
  rotation: [0, 0, 0, 1],
  mass: 0,
  kind: 'static',
  layer: 0b0001,
  mask: 0xffff,
  friction: 0.8,
  restitution: 0,
});
world.addBody({
  id: 2,
  shape: 'box',
  dims: [0.5, 0.5, 0.5],
  position: [0, 5, 0],
  rotation: [0, 0, 0, 1],
  mass: 25,
  kind: 'dynamic',
  layer: 0b0010,
  mask: 0xffff,
  friction: 0.5,
  restitution: 0.1,
  // Contacts are off by default; this crate is one the game reacts to.
  flags: { reportContacts: true },
});

// Per frame: read the packed body rows, then ask a question or two.
const bodies = new Float32Array(64 * 15);
const rows = world.readBodies(bodies);
const hit = world.raycast([0, 2, 0], [0, 0, -1], 100, 0xffff);
if (hit) console.log(`shot body ${String(hit.body)} at ${hit.distance.toFixed(2)} m`);
```

## API

**Module**

- `physics(options?)` — the `EngineModule` factory. `id: 'physics'`, `order: 0`,
  `fixedUpdate` steps the world and then fires `physics:stepped`. Options:
  `gravity`, `maxBodies`, `layers`, `substeps`, `maxContactsPerStep`, `wasmUrl`.
- `service.debugWireframe(scene | null)` — attach or detach the line view.
- `'physics:stepped'` — engine event, one `PhysicsSteppedEvent` per fixed step,
  fired the moment body state is post-step. The payload is reused; never retain
  it. This is where the host reads the rows it draws bodies from.

**World**

- `loadJolt({ wasmUrl? })` — instantiate the wasm module, once per page.
- `createPhysicsWorld(jolt, options?)` — a bare `PhysicsWorld`.
- `addBody(args)`, `removeBody(id)`, `setTransform`, `setVelocity`,
  `applyImpulse`, `setEnabled`, `moveCharacter`, `groundState` — one per WIT
  physics command.
- `step(dt, substeps?)` — advance, then queue this step's contacts.
- `readBodies(out)` — stride 15: `[id, pos×3, quat×4, linVel×3, angVel×3, groundState]`,
  ascending by id, enabled non-static bodies only. Returns the rows it _wanted_;
  size `out` from `movingBodyCount` and it never has to be called twice. A
  sleeping body replays its last row rather than crossing for it again.
- `drainContacts(out)` — pooled `ContactRecord`s, `begin` / `stay` / `end`, for
  the bodies that asked (`flags.reportContacts`, plus `flags.reportStay` for
  `stay`).
- `raycast`, `raycastBatch`, `overlapSphere`, `overlapSphereInto` — the only
  synchronous host imports. Batch stride in 7, out 9.
- `bodyCount`, `movingBodyCount`, `revision`, `bodyIds()`, `readBodyBounds()`,
  `readBodyPose()` — for debug views and for sizing a read.
- `dispose()` — frees every Jolt object.

**Shapes**

- `meshShapeFromGeometry(jolt, positions, indices)` — static triangle collider.
- `convexHullFromPoints(jolt, points)` — dynamic-capable hull, for splat props.

## Gotchas

- **Physics steps inside `fixedUpdate`, never in `update`.** Reading body state
  in `update` gives you the interpolated pose.
- **Contacts are opt-in, and `stay` is opt-in again.** A body reports nothing
  unless `flags.reportContacts` says so, and even then only `begin` and `end`
  until `flags.reportStay` is set too. One flagged side of a pair is enough.
  The default is off because a resting stack generates a manifold per pair per
  step whether or not anyone reads it. A step that exceeds
  `maxContactsPerStep` (256) drops the surplus and warns once.
- **A disabled character is not really disabled.** `setEnabled(id, false)` stops
  a `character` body being stepped and being read, but its inner body belongs to
  the controller and stays in the broad phase, so things still bump into it.
  Remove it instead when it has to stop existing.
- **Jolt frees nothing.** It is C++ behind emscripten: every `new jolt.X` needs a
  matching `jolt.destroy`, and every reference-counted object an
  `AddRef`/`Release` pair. `world.dispose()` is the one place in this package
  that has to get that right; if you build shapes yourself, `Release()` them.
- **Returned objects are reused.** `raycast` hands back one `RayHit` instance and
  `drainContacts` fills your pool in place. Copy what you need before the next
  call; do not keep the reference.
- **`layer` and `mask` are bitsets, and both must agree.** Two bodies collide
  only when `a.mask & b.layer` _and_ `b.mask & a.layer` are non-zero. Each
  distinct `(layer, mask)` pair costs one Jolt object layer out of
  `layers.maxObjectLayers` (64 by default, half static and half moving).
- **Mesh colliders respect winding.** Jolt ignores mesh back faces, so a ray can
  pass straight through a triangle wound the wrong way. Faces must be
  counter-clockwise seen from the front.
- **Queries are synchronous and therefore cheap to over-use.** Batch them:
  `raycastBatch` is one call for N rays. `overlapSphere` allocates its result
  array — use `overlapSphereInto` in anything that runs per step.
- **A character is not a rigid body.** `moveCharacter` takes horizontal velocity
  literally (no inertia) and treats a positive `y` while grounded as a jump;
  gravity is integrated for you while airborne. Impulses do nothing to it.
