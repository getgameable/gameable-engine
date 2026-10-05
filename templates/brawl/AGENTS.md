# AGENTS.md

## What this is

A multiplayer fighting game built on Gameable Engine. It already works: two
to four players in the placeholder arena, a punch, a dash and a ground slam,
knockouts, respawns and rounds. You are here to change it, not to finish it.

## The one rule

**Edit `src/game.ts`.** Most changes are a number in `rules`. If a change
needs more, the next files, in order:

| File                       | What lives there                                         |
| -------------------------- | -------------------------------------------------------- |
| `src/game.ts`              | What exists, where each system runs, every tuning number |
| `src/systems/abilities.ts` | Punch, dash and slam: the checks and what a hit does     |
| `src/messages.ts`          | What pages send up and the authority sends down          |
| `src/systems/round.ts`     | Knockouts, respawns, the round and the room's phase      |
| `src/systems/move.ts`      | Walking, dash and knockback, on both sides               |
| `src/systems/controls.ts`  | The page: keys to messages, the hit sound, the camera    |
| `src/fight.ts`             | Per-seat state, the spawns, the phase words              |
| `src/main.ts`              | The host: engine boot and the room. Rarely.              |

**Never edit anything under `node_modules/@gameable/`.** If the game cannot be
written without an engine change, say so and stop.

## Hard rules

1. **`game.ts` and everything it imports run inside the wasm guest.** No DOM,
   no `fetch`, no `Date.now()`, no `Math.random()` (use `ctx.rng`). `main.ts`
   and the host files it imports (`hostAssets.ts`, `session.ts`, `solo.ts`,
   `sandbox.ts`) stay in the browser.
2. **The authority decides.** An ability is a message; only
   `src/systems/abilities.ts`, on the authority, says whether it lands. Never
   trust a page with damage, positions or cooldowns.
3. **`move` runs on both sides and must stay the same on both.** The page
   predicts its own fighter with it. The same keys must give the same walk,
   or every step is a correction. `Fighter` and `OwnBody` share one body.
4. **No allocation in a system.** Per-seat state is a flat lane in
   `src/fight.ts`; payload objects are hoisted and reused.
5. **Module state is frozen into the wasm component.** Reset it in `init`.
6. **A message is declared once** with `defineMessage` and a check.

## Commands

| Command               | Does                                                            |
| --------------------- | --------------------------------------------------------------- |
| `npm run build:guest` | The wasm guest Play Solo's authority runs; rerun after a change |
| `npm run dev`         | Vite dev server: Play Solo, and `?room=` for a real room        |
| `npm test`            | The fight on the authority, and two pages over 150 ms           |
| `npm run build`       | Guest component + production bundle                             |

## Where to look next

- `README.md`: what to change first, and how a hit is decided.
- The recipes: add a kick, play with friends, send a message.
