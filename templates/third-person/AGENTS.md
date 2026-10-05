# AGENTS.md

## What this is

A playable third-person adventure built on Gameable Engine. It already works: a splat
arena, a hero on a collision-aware follow camera, two people to talk to, two
chests, a locked door, a key, and a win condition. You are here to change it,
not to finish it.

## The one rule

**Edit `src/game.ts`.** Almost everything worth changing is a number in the
`rules` block, an entry in `spawns`, or a line in `init`. If a change needs more
than that, the next files to reach for, in order, are:

| File                        | What lives there                                 |
| --------------------------- | ------------------------------------------------ |
| `src/game.ts`               | What exists, where, and every tuning number      |
| `src/prefabs.ts`            | What things are made of: shape, tags, colours    |
| `src/dialogue.json`         | What people say                                  |
| `src/systems/locomotion.ts` | Idle/walk/run/jump/fall, and the orbit camera    |
| `src/systems/interact.ts`   | The `E` prompt, chests, the key, the door        |
| `src/systems/dialogue.ts`   | Walking a conversation, expressions, gaze        |
| `src/hud.ts`                | What the HUD shows                               |
| `src/arena.ts`              | Where things spawn                               |
| `src/main.ts`               | The host: engine boot, lights, collider. Rarely. |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop — that is a missing feature,
not a workaround.

## Hard rules

1. **`game.ts` and everything it imports run inside the wasm guest.** No
   DOM, no `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`). The
   only way out is a command, and the facades on `ctx` build those for you.
   `main.ts` and the host files it imports (`hostAssets.ts`, `sandbox.ts`,
   `session.ts`, `online.ts`, `solo.ts`, `testHooks.ts`) stay in the browser.
2. **No allocation in a system.** Systems run sixty times a second. Hoist your
   vectors and your query term arrays to module scope and mutate them. A `{ x,
y, z }` literal inside a loop is a frame spike later.
3. **Assets are string ids.** `'sfx.key'`, never a path and never a URL. A new
   asset is an entry in `src/assets.json`, nothing else.
4. **Import `three/webgpu`, never bare `three`** — and game code should not
   import three at all.
5. **Seed randomness from `ctx.rng`.** Module-level state is frozen into the
   wasm component at build time, so anything mutable must be reset in
   `defineGame({ init })`. Every system here has a `resetX` for that reason.
6. **`hud.set` compares one level deep.** A nested object mutated in place
   looks unchanged and is never sent. `src/hud.ts` shows the pattern: keep a
   flat mirror, rebuild the model only when it actually changed.
7. **Tags say what a thing is.** A prop carries `Interactable` plus one of
   `Chest` / `Door` / `Npc` / `Key`, and `classifyInteractables` turns those
   into a number once, in `init`. That is what makes the level a declarative
   `spawns` list with nothing to patch up afterwards.

## What draws, and what does not

The hero and both NPCs are drawn by `gameable/aosrig`: one skinned
114-joint GLB with `idle`, `walk`, `run` and `wave` in it, declared in
`src/assets.json` with `rig: { backend: 'skinned' }` and named by the
`character` field of a prefab. Four commands drive it:

- `spawn-character` — names a manifest id; the host loads the GLB, clones it and
  drops the placeholder capsule.
- `set-character-state` — `src/systems/locomotion.ts` sends the hero's state and
  velocity every frame, and the host blends idle/walk/run from the velocity.
- `set-expression` — `src/systems/dialogue.ts` sends an ARKit-52 vector per
  line. The skinned rig has no blendshapes, so this is recorded and warned about
  once; `?gnm=1` gives the guide a face that uses it.
- `look-at` — a gaze target per line. The neck and head turn towards it.

Facing is not a command: `src/systems/locomotion.ts` writes `Transform.q*` for
the hero, and `place()` in `src/game.ts` spawns the NPCs turned to their arena
yaw. **Yaw 0 faces `+Z`.**

They are all asserted in `tests/game.test.ts`, and the host keeps the last
animation intent per entity on `adapter.animationOf(entity)`.

## Commands

| Command                | Does                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `npm run dev`          | Vite dev server, direct sandbox: your TypeScript, no build¹ |
| `npm test`             | Headless gameplay tests through `gameable/test`             |
| `npm run build`        | Guest component + production bundle                         |
| `npm run preview`      | Serve the production build                                  |
| `npm run build:direct` | Production bundle with the direct sandbox, for debugging    |

¹ With `features.multiplayer` on, Play Solo's authority runs the **built** guest
even under `npm run dev`: run `npm run build:guest` first and after every rule
change. The page warns when `build/guest/` is older than `src/`.

`npm run dev` and `npm run build` run the same game. If they behave
differently, that is an engine bug — report it rather than working around it.

## Where to look next

- `README.md` — what the template contains and how to change it.
- The recipes in the engine docs: add an interactable, add NPC dialogue, tune
  the follow camera, add a locomotion state. Each one is at most two files.
