# AGENTS.md

## What this is

A playable multiplayer survival game built on Gameable Engine: four to six
players, a day/night clock, trees to gather wood from, walls to build, and
creatures that come at night. It already works. You are here to change it,
not to finish it.

## The one rule

**Edit `src/game.ts`.** The numbers worth changing are in its `rules` block;
the three to try first are `daySeconds`, `creaturesFirstNight` and `wallCost`.
If a change needs more than that, the next files to reach for, in order, are:

| File                       | What lives there                                         |
| -------------------------- | -------------------------------------------------------- |
| `src/game.ts`              | Features, the player block, the trees, every rule, order |
| `src/systems/clock.ts`     | Dusk and dawn: spawning, counting nights, getting up     |
| `src/systems/creatures.ts` | The nearest camp body, the chase and the hit             |
| `src/systems/work.ts`      | Gather and build                                         |
| `src/messages.ts`          | What players send up, and each message's check           |
| `src/prefabs.ts`           | Survivor, Creature, Tree, Wall: shapes, health, tags     |
| `src/hud.ts`               | What each player's HUD says                              |
| `src/camp.ts`              | The camp's state on the authority                        |
| `src/main.ts`              | The host: engine boot, the room, the page. Rarely.       |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop: that is a missing feature,
not a workaround.

## Hard rules

1. **`game.ts` and everything it imports run inside the wasm guest.** No DOM,
   no `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`). `main.ts`
   and the host files it imports (`hostAssets.ts`, `session.ts`, `solo.ts`,
   `testHooks.ts`) stay in the browser.
2. **Every system says where it runs.** `on: 'authority'` for anything that
   decides (it owns the bodies, the wood and the clock); `on: 'client'` for
   keys and local sounds.
3. **No allocation in a system.** Systems run sixty times a second. Hoist
   vectors and arrays to module scope; the camp's state is flat lanes indexed
   by player id (`src/camp.ts`).
4. **`ctx.players` is read by id, never iterated.** A `Map` iterator is an
   allocation every tick.
5. **Assets are string ids.** `'sfx.hit'`, never a path or a URL. A new asset
   is an entry in `src/assets.json`.
6. **Module-level state is frozen into the wasm component at build time.**
   Anything mutable is reset in `defineGame({ init })`.

## Commands

| Command                       | Does                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `npm test`                    | The camp, driven headlessly as the room's authority         |
| `npm run build:guest`         | The wasm guest Play Solo's authority runs: after every edit |
| `npm run dev`                 | The page, http://localhost:5195; no `?room=` plays solo     |
| `npx gameable serve --direct` | A local room server on 8790, from `src/game.ts` as-is       |
| `npm run build`               | Guest component + production bundle                         |

Two tabs in one room: `http://localhost:5195/?room=new&rooms=http://localhost:8790`,
then **Copy link** into the second tab. Restart `serve --direct` after an edit.

## Where to look next

- `README.md`: what is here, the messages, and the gotchas.
- The recipes in the engine docs: play with friends, send a message, add a
  night cycle. Each one is at most two files.
