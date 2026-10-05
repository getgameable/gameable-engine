# gameable

## What

The guest-side API. `defineGame`, the bitecs re-exports, the built-in SoA
components and systems, prefabs, and the `input` / `physics` / `camera` / `hud`
/ `audio` / `character` facades that marshal across the wasm boundary without
allocating.

Everything here runs in two places and must behave identically in both: QuickJS
inside the compiled component, and V8 in `mode: 'direct'` (the Vite dev server
and vitest).

## When to use

Always, when you are writing a game. This is the single import a game module
needs. You do not import `gameable/core`, `three`, or anything else.

## Install

```sh
npm install gameable
```

Inside this repository the package is a workspace member and needs no install.

## Minimal example

```ts
import { defineGame, prefab, Health } from 'gameable';

const Player = prefab({
  name: 'player',
  body: { shape: 'capsule', dims: [0.3, 0.9], kind: 'character', mass: 80 },
  health: 100,
});

const Enemy = prefab({
  asset: 'enemy-capsule',
  body: { shape: 'capsule', dims: [0.3, 0.9], kind: 'dynamic', mass: 60 },
  health: 30,
});

export default defineGame({
  assets: ['arena', 'enemy-capsule', 'shot'],
  world: { gravity: -9.81 },
  player: { prefab: Player, spawn: [0, 1, 0], camera: 'firstPerson' },
  spawns: [{ prefab: Enemy, position: [0, 1, -6] }],

  systems: [
    // Walk with WASD, in the camera's yaw frame.
    (ctx) => {
      const move = ctx.input.axis2('A', 'D', 'S', 'W');
      const yaw = ctx.camera.look.yaw;
      const vx = (move.x * Math.cos(yaw) - move.y * Math.sin(yaw)) * 4;
      const vz = (-move.x * Math.sin(yaw) - move.y * Math.cos(yaw)) * 4;
      ctx.physics.moveCharacter(ctx.player, vx, 0, vz, ctx.input.pressed('Space'));
    },

    // Hitscan on left mouse button.
    (ctx) => {
      if (!ctx.input.mousePressed(1)) return;
      const hit = ctx.physics.raycast(eye, forward, 100, undefined, ctx.player);
      ctx.audio.play('shot', { entity: ctx.player });
      if (hit) Health.current[hit.entity] -= 10;
    },

    // HUD JSON only crosses on the frames it changed.
    (ctx) => {
      ctx.hud.set({ health: Health.current[ctx.player] });
    },
  ],
});

const eye = { x: 0, y: 1.7, z: 0 };
const forward = { x: 0, y: 0, z: -1 };
```

## API

- **`defineGame({ assets, world, player, spawns, rules, systems, init, update, shutdown, snapshot, restore })`** —
  the declaration a game module default-exports. Declarative fields are sugar
  over built-in systems that run before yours, in a fixed order.
- **`featuresOf(definition)`** — the game's `features` block as a frozen table,
  name to options (`true` becomes `{}`, `false` is dropped). The host reads it
  to decide which feature modules to load.
- **`roomSeats(definition)`** — the seats a room game declares,
  `features.multiplayer.maxPlayers` (`DEFAULT_ROOM_SEATS`, 8, for
  `multiplayer: true`; undefined without the feature). Seats are ids
  `0..seats - 1`. The guest makes exactly that many player slots and ignores a
  join past them; `createEngineRoomGame` and `createRoom` read the same number.
  `roomSendHz` reads `sendHz` (20; 1 to 60).
- **`player.spawn`** — one point `[x, y, z]` for every seat, a list of points
  (seat `i` takes `list[i % n]`), or `(seat, ctx) => ({ x, y, z })`. A
  single-player game spawns seat 0. The function runs inside the step: keep it
  deterministic (seat, `ctx.rules`, `ctx.rng`).
- **`ctx.players`** — a read-only `Map` from id to `PlayerHandle`, plus `host`
  (the first joiner, who stays host until they leave or drop; then the lowest
  seat still joined; undefined with nobody joined; kept by snapshots; also
  `PlayerHandle.isHost`) and `list`, the same players in id order in one array
  kept for the whole run. Walk `list` with an index in a system: iterating the
  map allocates.
- **`ctx.data`** — player documents in the room's store, written by the
  authority. `ctx.players.get(id).data` is the document the room loaded at
  join (`null` for none), `.savedAt` when the store last wrote it and
  `.joinedAt` the server's clock at the load (ms since the epoch; offline time
  is `joinedAt - savedAt`; `savedAt` is `null` with no document, `joinedAt`
  without a store). `ctx.data.save(id, doc)` replaces it
  and has the room write it, at most once per 6 s per player and always when
  the player leaves or the room closes. `ctx.data.exchange(a, b, give, take)`
  trades all or nothing (`applyTransfer`: numbers move amounts, lists move
  items; an object item such as a pet matches by value, whatever its key
  order) and returns an id; its result is in `ctx.data.results()` a tick or
  more later, and on success both players' `data` already show the trade.
  `ctx.data.game` and `ctx.data.saveGame(doc)` are the game's own document.
  On a client every call does nothing (logged once).
- **`defineMessage(name, check, { maxBytes })`** — a checked message for
  `ctx.net.messages(def)` and `ctx.net.send(def, payload)`; a bad payload is
  dropped and counted in `ctx.net.stats`.
- **`prefab(spec)` / `spawn(def, position, rotation?)` / `despawn(entity)`** —
  entity templates. `spawn` mints the entity and body ids and queues the
  `spawn` / `add-body` / `spawn-character` commands. Freed body ids are reused,
  lowest first: ids stay under the live body count (`maxBodies`).
- **ECS** — `createWorld`, `addEntity`, `removeEntity`, `addComponent`,
  `removeComponent`, `hasComponent`, `query`, `Not`/`Or`/`And` re-exported from
  bitecs 0.4, plus the built-in SoA components `Transform`, `Renderable`,
  `RigidBody`, `Character`, `Velocity`, `Health` and the tags `Player`,
  `Enemy`, `Pickup`. `configureEcs(n)` resizes them; the default is 4096.
- **Facades** — `input` (`isDown`, `pressed`, `released`, `axis2`, `mouse`,
  `gamepad`), `physics` (`raycast`, `raycastBatch`, `overlapSphere`,
  `moveCharacter`, `applyImpulse`, `setVelocity`, `teleport`), `camera`
  (`firstPerson`, `follow`, `set`, `lookAt`, `look`), `hud` (`set`,
  `invalidate`, `clear`), `audio` (`play`, `stop`, `listener`), `character`
  (`setState`, `setClipWeights`, `setExpression`, `lookAt`, `say`).
- **`createGuest(host, definition)`** — the runtime behind both sandbox modes.
  `gameable/host` calls it for you.
- **`createRng(seed)`**, `assetId(name)`, `writeSnapshot` / `readSnapshot`,
  `TransformPacker`, `BodyIndex`, `CommandBuffer`, `commandPoolSize()`.
- **`gameable/sdk/keycodes`** — the canonical key table. `gameable/input`
  imports it so host and guest agree bit for bit.
- **`gameable/sdk/prelude`** — the QuickJS compatibility layer, imported
  first by the componentize entry.

`createThirdPersonController(clips?)` shares camera-relative acceleration,
shortest-path turning, a configurable idle-turn threshold (default 90 degrees),
and contact-driven jump phases. Create it once, call `reset(ctx)` from game init
and `update(ctx, frozen?)` from a system. On a room's authority call
`updatePlayers(ctx, frozen?)` instead: it moves each player's own entity (the one
they possess) from their own input, with their own camera, keeping one state per
seat (`stateOf(id)`), reset when the seat's entity changes. Tune movement and camera through
`ctx.rules`. Optional `{ idle, walk, run, rise, fall, land }` clip names enable an
explicit base blend; the asset bundle must contain all six clips. Otherwise the
animator uses its standard speed blend.

`physics.isGrounded(entity)` reads the last packed Jolt contact result without a
host call. It returns false for unknown, steep, unsupported and airborne states,
including a stationary jump apex. The body buffer now has stride 15; rebuild
hosts, guests and replay fixtures together. Snapshots use version 2 because the
contact lane is persisted; version 1 snapshots are rejected explicitly.

## Gotchas

- **One direct guest per JS realm.** The component arrays are shared, so a
  direct guest started before another throws on its next `tick`. Run one as
  wasm. A `client` role runs no level `spawns`.
- **Seed randomness in `init`, from `env.seed()`.** Wizer snapshots the QuickJS
  heap at build time, so anything derived from `Math.random()` or `Date.now()`
  at module scope is frozen into the binary. In the component, `Math.random()`
  throws until the runtime seeds it; in V8 the prelude leaves the global alone,
  so a game that calls it there will still be non-deterministic. Use `ctx.rng`.
- **Never `instanceof` or `.subarray()` an incoming list.** jco hands the guest
  a plain `Array` for `list<f32>` and `list<u32>`; direct mode hands it a
  `Float32Array`. The types say `ArrayLike<number>` for exactly this reason.
- **Never emit a zero-length `list<f32>`.** jco's lifter rejects the pointer
  QuickJS returns for one. `TransformPacker` emits a single all-zero row
  instead, which the host skips.
- **Assets are string ids.** Resolve them in `init`; the SDK caches, and warns
  when a name is resolved during `tick`.
- **No allocation in a system.** `axis2`, `input.mouse` and the command list
  are pooled objects that are reused every frame. Read them; never retain them.
  `for (const [id, p] of ctx.players)` makes an iterator and a pair per player:
  walk `ctx.players.list` by index instead.
- **`ctx.data.save` serialises the document.** Call it when the document
  changed, not every tick. Saves made between an exchange and its result are
  dropped by the room (the SDK saves both traded documents when the result
  arrives); a player who leaves inside that window loses those saves, not the trade.
- **Key names are case-sensitive**, except that a bare letter or F-key also
  answers in lower case (`'w'`, `'f1'`). `'shift'` is unknown: write `'Shift'`.
- **A bad `features.multiplayer.maxPlayers` fails `init`**, in a single-player
  run too: anything but a whole number from 1 to 4097 is `init-failed`.
- **A dropped host hands the role on while the room holds their seat** (30
  seconds on the room server, its catalog entry's `reconnectSeconds`). The room
  leaves a held seat out of `frame-input.players`, and the SDK reads that as gone
  for the host role alone: `host` moves to the lowest seat in the list and stays
  there when the old host is back. The player is still joined (`connected`), and
  the guest hears `player-left` only when the hold times out.
- **Floats cross as `f32`.** The SDK rounds on the way out so direct mode and
  wasm mode stay bit-identical; do not be surprised when `0.1` comes back as
  `0.10000000149011612`.
