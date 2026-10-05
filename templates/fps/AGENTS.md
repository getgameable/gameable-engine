# AGENTS.md

## What this is

A playable first-person shooter built on Gameable Engine. It already works: a splat
arena, six enemies that chase and hit you, a hitscan rifle, medkits, a HUD and
a win condition. You are here to change it, not to finish it.

## The one rule

**Edit `src/game.ts`.** Almost everything worth changing is a number in the
`rules` block or a line in `init`. If a change needs more than that, the next
files to reach for, in order, are:

| File                     | What lives there                                     |
| ------------------------ | ---------------------------------------------------- |
| `src/game.ts`            | What exists, where, and every tuning number          |
| `src/prefabs.ts`         | What things are made of: shape, mass, layers, health |
| `src/systems/weapon.ts`  | Firing, damage, reload                               |
| `src/systems/enemyAI.ts` | Idle, chase, attack                                  |
| `src/systems/pickups.ts` | Medkits                                              |
| `src/hud.ts`             | What the HUD shows                                   |
| `src/arena.ts`           | Where things spawn                                   |
| `src/main.ts`            | The host: engine boot, lights, collider. Rarely.     |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop — that is a missing feature,
not a workaround.

## Hard rules

1. **Everything in `src/` except `main.ts` runs inside the wasm guest.** No
   DOM, no `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`). The
   only way out is a command, and the facades on `ctx` build those for you.
2. **No allocation in a system.** Systems run sixty times a second. Hoist your
   vectors and your query term arrays to module scope and mutate them. A `{ x,
y, z }` literal inside a loop is a frame spike later.
3. **Assets are string ids.** `'sfx.shot'`, never a path and never a URL. A new
   asset is an entry in `src/assets.json`, nothing else.
4. **Import `three/webgpu`, never bare `three`** — and game code should not
   import three at all.
5. **Seed randomness from `ctx.rng`.** Module-level state is frozen into the
   wasm component at build time, so anything mutable must be reset in
   `defineGame({ init })`. Every system here has a `resetX` for that reason.
6. **`hud.set` compares one level deep.** A nested object mutated in place
   looks unchanged and is never sent. `src/hud.ts` shows the pattern: keep a
   flat mirror, rebuild the model only when it actually changed.

## Commands

| Command                | Does                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `npm run dev`          | Vite dev server, direct sandbox: your TypeScript, no build |
| `npm test`             | Headless gameplay tests through `gameable/test`            |
| `npm run build`        | Guest component + production bundle                        |
| `npm run preview`      | Serve the production build                                 |
| `npm run build:direct` | Production bundle with the direct sandbox, for debugging   |

`npm run dev` and `npm run build` run the same game. If they behave
differently, that is an engine bug — report it rather than working around it.

## Where to look next

- `README.md` — what the template contains and how to change it.
- The recipes in the engine docs: add a weapon, add an enemy, change the level,
  add a HUD element. Each one is at most two files.
